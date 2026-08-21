/**
 * Softphone controller — the actual point of this prototype.
 *
 * The Exotel CRM SDK gives you a phone object with events. It does NOT give you
 * a state machine, and the shape of its events is misleading in one specific
 * way that breaks naive integrations:
 *
 *   MakeCall() does not open a call. It POSTs to Exotel and returns.
 *   Exotel then rings THIS BROWSER, and the SDK reports it as `incoming`.
 *
 * So an outbound call arrives at your code as an inbound event. If you render
 * every `incoming` as "Call from <number>" with Accept/Reject buttons, then
 * clicking Call in your CRM makes your own app ask the agent whether they'd
 * like to accept the call they just placed. That is the bug this file exists
 * to prevent.
 *
 * The fix is correlation: remember that we asked for a call, and when a leg
 * shows up inside the correlation window, adopt it as ours and auto-answer.
 */

import ExotelCRMWebSDK from '@exotel-npm-dev/exotel-ip-calling-crm-websdk';
import type { ActiveCall, CallLegs, PhoneSnapshot, PhoneState, ServerCallUpdate } from '../types';

// The SDK's own event names. Note `callEnded` is camelCase here even though the
// low-level SDK docs write it `callended`. Trust the type declarations.
type SdkCallEvent = 'incoming' | 'connected' | 'callEnded' | 'holdtoggle' | 'mutetoggle';

interface SdkCallData {
  callId: string;
  remoteId: string;
  remoteDisplayName: string;
  callDirection: string;
  callState: string;
  callEndReason: string;
  callFromNumber?: string;
}

export interface SoftphoneOptions {
  /** Short-lived app token from YOUR backend. Never the app secret. */
  accessToken: string;
  /** AppUserId of the signed-in agent. */
  userId: string;
  /**
   * How long to wait for Exotel to ring us back after MakeCall before
   * giving up. Agent legs normally arrive in 1-3s; 20s is generous.
   */
  outboundLegTimeoutMs?: number;
  /**
   * Auto-answer the agent leg of a call WE placed. Leave this on.
   *
   * Outbound calls arrive at this client as an `incoming` event (see the note
   * at the top of this file). With this off, clicking Call makes the app prompt
   * the agent to accept the call they just placed — the exact bug this module
   * exists to prevent. It is a flag only so the behaviour is visible in the
   * options rather than buried in a handler.
   *
   * Genuine inbound calls are never auto-answered regardless of this setting.
   */
  autoAnswerOutbound?: boolean;
  onChange: (snapshot: PhoneSnapshot) => void;
}

const IDLE_LEGS: CallLegs = { agent: 'down', customer: 'down' };

export class Softphone {
  private phone: any = null;
  private opts: Required<Omit<SoftphoneOptions, 'onChange'>> & Pick<SoftphoneOptions, 'onChange'>;

  private state: PhoneState = 'offline';
  private registered = false;
  private legs: CallLegs = { ...IDLE_LEGS };
  private call: ActiveCall | null = null;
  private muted = false;
  private held = false;
  private error: string | null = null;
  private isLeader = true;

  /**
   * Set between MakeCall and the arrival of the agent leg. Its presence is what
   * makes an `incoming` event ours rather than a customer's.
   */
  private pendingOutbound: {
    to: string;
    customField?: string;
    requestedAt: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(options: SoftphoneOptions) {
    this.opts = { outboundLegTimeoutMs: 20_000, autoAnswerOutbound: true, ...options };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.set({ state: 'connecting', error: null });

    // autoConnectVOIP=false so registration is explicit and we can gate it on
    // tab leadership. Passing true here means every open tab registers.
    const sdk = new ExotelCRMWebSDK(this.opts.accessToken, this.opts.userId, false);

    // Initialize() makes three browser-side fetches to icore: /app,
    // /app_setting and /usermapping. It resolves with the phone object, or
    // throws with the failing status embedded in the message.
    const phone = await sdk.Initialize(
      this.onCallEvent,
      this.onRegisterEvent as any,
      this.onSessionEvent as any,
    );

    if (!phone) {
      this.set({
        state: 'failed',
        error: 'SDK initialize returned nothing. Usually a bad or expired access token.',
      });
      return;
    }

    this.phone = phone;
    if (this.isLeader) phone.RegisterDevice();
  }

  disconnect(): void {
    this.clearPending();
    this.phone?.UnRegisterDevice();
    this.set({ state: 'offline', registered: false, legs: { ...IDLE_LEGS }, call: null });
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /**
   * Place an outbound call.
   *
   * Two things to note about the real SDK signature:
   *
   *  - v1.2.2 is `MakeCall(number, callback)`. The README documents a third
   *    CustomField argument; the shipped type declarations do not have it. If
   *    you need a CRM record id on the call, correlate on the returned CallSid
   *    in your backend webhook instead of relying on CustomField.
   *
   *  - The callback fires when Exotel ACCEPTS THE REQUEST, not when anything
   *    rings and not when the customer answers. `status: "success"` means
   *    "queued", nothing more.
   */
  async dial(to: string, customField?: string): Promise<void> {
    if (!this.phone) throw new Error('Not connected');
    if (!this.registered) throw new Error('SIP device is not registered — nothing can ring');
    if (this.call) throw new Error('Already on a call');

    // Arm correlation BEFORE the request. The agent leg can arrive faster than
    // the fetch resolves, and if it beats the flag we misclassify our own call.
    this.pendingOutbound = {
      to,
      customField,
      requestedAt: Date.now(),
      timer: setTimeout(() => this.onOutboundLegTimeout(), this.opts.outboundLegTimeoutMs),
    };

    this.set({ state: 'placing', error: null, legs: { agent: 'down', customer: 'down' } });

    await this.phone.MakeCall(to, (status: 'success' | 'failed', data: any) => {
      if (status === 'failed') {
        this.clearPending();
        this.set({
          state: 'failed',
          error: describeDialFailure(data),
          legs: { ...IDLE_LEGS },
        });
        return;
      }
      // Request queued. Stash the CallSid so the backend webhook can be joined
      // to this UI session. Still waiting for the leg.
      const callSid = data?.Data?.CallSid ?? data?.CallSid ?? data?.call_sid;
      if (this.call) this.call.callSid = callSid;
      else this.pendingCallSid = callSid;
    });
  }

  private pendingCallSid: string | undefined;

  private onOutboundLegTimeout() {
    if (!this.pendingOutbound) return;
    const { to } = this.pendingOutbound;
    this.clearPending();
    this.set({
      state: 'failed',
      legs: { ...IDLE_LEGS },
      error:
        `Exotel accepted the request to call ${to} but never rang this browser. ` +
        `Check that the agent's active device is "sip" and not "phone", and that ` +
        `the agent is not marked busy on another call.`,
    });
  }

  private clearPending() {
    if (this.pendingOutbound) clearTimeout(this.pendingOutbound.timer);
    this.pendingOutbound = null;
  }

  // -------------------------------------------------------------------------
  // Inbound + shared controls
  // -------------------------------------------------------------------------

  answer(): void {
    this.phone?.AcceptCall();
  }

  /**
   * Decline a ringing call.
   *
   * The CRM SDK exposes no RejectCall — only AcceptCall and HangupCall. But
   * HangupCall routes to the core SDK's rejectCall(), and for a session that
   * was never answered SIP.js sends a reject rather than a BYE on a dialog that
   * does not exist. So this is the correct decline, not a workaround.
   *
   * Guarded on `ringing` so a stray click cannot drop a live call: use hangup()
   * for that, which is a different intent and reads differently in the UI.
   */
  decline(): void {
    if (this.state !== 'ringing') return;
    this.set({ state: 'ending', error: null });
    this.phone?.HangupCall();
  }

  hangup(): void {
    this.set({ state: 'ending' });
    this.phone?.HangupCall();
  }

  toggleMute(): void {
    this.phone?.ToggleMute();
  }

  toggleHold(): void {
    this.phone?.ToggleHold();
  }

  sendDtmf(digit: string): void {
    // Present on the phone object even though the README omits it.
    this.phone?.SendDTMF(digit);
  }

  reset(): void {
    this.clearPending();
    this.set({
      state: this.registered ? 'ready' : 'offline',
      legs: { ...IDLE_LEGS },
      call: null,
      muted: false,
      held: false,
      error: null,
    });
  }

  /** Call this when tab leadership changes. Only the leader registers. */
  setLeader(isLeader: boolean): void {
    this.isLeader = isLeader;
    if (!this.phone) return;
    if (isLeader && !this.registered) this.phone.RegisterDevice();
    if (!isLeader && this.registered) this.phone.UnRegisterDevice();
    this.emit();
  }

  // -------------------------------------------------------------------------
  // SDK event handlers
  // -------------------------------------------------------------------------

  private onRegisterEvent = (event: string) => {
    // States seen from the SDK: registered / unregistered / terminated / sent request
    const normalized = String(event).toLowerCase();
    if (normalized === 'registered') {
      this.set({ registered: true, state: this.call ? this.state : 'ready', error: null });
    } else if (normalized === 'terminated') {
      this.set({
        registered: false,
        state: 'failed',
        error: 'SIP registration was rejected. Credentials are wrong or the keepalive died.',
      });
    } else if (normalized === 'unregistered') {
      this.set({ registered: false, state: 'offline' });
    }
  };

  private onCallEvent = (event: SdkCallEvent, data: SdkCallData) => {
    switch (event) {
      case 'incoming':
        return this.onIncoming(data);

      case 'connected': {
        // The agent leg is up. That is ALL this means. For an outbound call the
        // customer has not been reached yet — Exotel is only now dialling out.
        const outbound = this.call?.direction === 'outbound';
        this.set({
          state: outbound ? 'dialing_customer' : 'live',
          legs: { agent: 'up', customer: outbound ? 'ringing' : 'up' },
          call: this.call ? { ...this.call, answeredAt: Date.now() } : null,
        });
        return;
      }

      case 'callEnded': {
        this.clearPending();
        this.set({
          state: this.registered ? 'ready' : 'offline',
          legs: { ...IDLE_LEGS },
          call: null,
          muted: false,
          held: false,
          error: data?.callEndReason ? `Call ended: ${data.callEndReason}` : null,
        });
        return;
      }

      // The CRM layer does emit these, unlike the low-level SDK where mute and
      // hold are silent toggles you have to track yourself.
      case 'mutetoggle':
        this.set({ muted: !this.muted });
        return;

      case 'holdtoggle':
        this.set({ held: !this.held });
        return;
    }
  };

  private onIncoming(data: SdkCallData) {
    const pending = this.pendingOutbound;

    // --- The correlation decision --------------------------------------
    // Is this leg the one we asked for, or a real customer calling in?
    if (pending) {
      this.clearPending();
      this.call = {
        direction: 'outbound',
        sipCallId: data.callId,
        callSid: this.pendingCallSid,
        peer: pending.to, // the number WE dialled, not data.remoteId
        customField: pending.customField,
        startedAt: pending.requestedAt,
      };
      this.pendingCallSid = undefined;
      this.set({ state: 'placing', legs: { agent: 'ringing', customer: 'down' } });

      // Auto-answer. The agent already expressed intent by clicking Call;
      // making them accept their own call is the bug described at the top.
      if (this.opts.autoAnswerOutbound) {
        this.answer();
      } else {
        // Opted out: fall through to the ringing UI. The agent will be asked to
        // accept a call they placed themselves — see the option's doc comment.
        this.set({ state: 'ringing' });
      }
      return;
    }

    // Genuine inbound. Show the ringing UI and wait for a human.
    this.call = {
      direction: 'inbound',
      sipCallId: data.callId,
      peer: data.callFromNumber || data.remoteId || data.remoteDisplayName || 'Unknown',
      startedAt: Date.now(),
    };
    this.set({ state: 'ringing', legs: { agent: 'ringing', customer: 'up' } });
  }

  private onSessionEvent = (state: string) => {
    // Multi-tab notifications arrive here. Non-leader tabs should display, not act.
    if (String(state).toLowerCase().includes('media permission denied')) {
      this.set({
        state: 'failed',
        error: 'Microphone access denied. Calls cannot connect without it.',
      });
    }
  };

  // -------------------------------------------------------------------------
  // Backend truth for the customer leg
  // -------------------------------------------------------------------------

  /**
   * Feed this from your backend's status-callback stream (SSE/WebSocket).
   *
   * The browser cannot observe the customer leg. Without this, "connected" in
   * your UI means "the agent's browser is connected to Exotel", which is not
   * what an agent reading the screen will assume it means.
   */
  applyServerUpdate(update: ServerCallUpdate): void {
    if (!this.call) return;
    if (update.callSid && this.call.callSid && update.callSid !== this.call.callSid) return;

    const customer = update.customerLeg;
    this.set({
      legs: { agent: this.legs.agent, customer },
      state: customer === 'up' && this.legs.agent === 'up' ? 'live' : this.state,
    });
  }

  // -------------------------------------------------------------------------
  // Snapshot plumbing
  // -------------------------------------------------------------------------

  private set(patch: Partial<PhoneSnapshot>): void {
    if (patch.state !== undefined) this.state = patch.state;
    if (patch.registered !== undefined) this.registered = patch.registered;
    if (patch.legs !== undefined) this.legs = patch.legs;
    if (patch.call !== undefined) this.call = patch.call;
    if (patch.muted !== undefined) this.muted = patch.muted;
    if (patch.held !== undefined) this.held = patch.held;
    if (patch.error !== undefined) this.error = patch.error;
    if (patch.isLeader !== undefined) this.isLeader = patch.isLeader;
    this.emit();
  }

  private emit(): void {
    this.opts.onChange(this.snapshot());
  }

  snapshot(): PhoneSnapshot {
    return {
      state: this.state,
      registered: this.registered,
      legs: { ...this.legs },
      call: this.call ? { ...this.call } : null,
      muted: this.muted,
      held: this.held,
      error: this.error,
      isLeader: this.isLeader,
    };
  }
}

/** Turn Exotel's dial errors into something an agent can act on. */
function describeDialFailure(data: any): string {
  const raw = typeof data === 'string' ? data : (data?.message ?? JSON.stringify(data ?? {}));
  if (/busy/i.test(raw)) return 'You are already marked busy on another call.';
  if (/device/i.test(raw)) return 'Your calling device is switched off. Turn on the SIP device and retry.';
  if (/caller ?id|virtual/i.test(raw)) return 'The caller ID is not a virtual number owned by this account.';
  if (/401|unauthor/i.test(raw)) return 'Access token expired. Refresh the session.';
  return `Could not place the call: ${raw}`.slice(0, 200);
}
