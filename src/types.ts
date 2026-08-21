/**
 * Shared types for the Exotel VoIP prototype.
 *
 * The single most important idea in this file is the LEG MODEL.
 *
 * An Exotel "outbound" call is really two legs bridged by Exotel:
 *
 *      agent leg                        customer leg
 *   browser <--WebRTC/SIP--> Exotel <--PSTN--> customer
 *
 * The browser SDK can only ever tell you about the AGENT leg, because that is
 * the only leg it is party to. The customer leg's truth arrives at your
 * BACKEND via status callbacks. Any UI that claims to know whether the
 * customer picked up, based only on browser events, is lying.
 */

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

export type LegState = 'down' | 'ringing' | 'up';

export interface CallLegs {
  /** Browser <-> Exotel. Known from SDK events. */
  agent: LegState;
  /** Exotel <-> customer PSTN. Only known from backend status callbacks. */
  customer: LegState;
}

// ---------------------------------------------------------------------------
// Phone state machine
// ---------------------------------------------------------------------------

export type PhoneState =
  /** SDK not initialised yet. */
  | 'offline'
  /** SIP REGISTER in flight. */
  | 'connecting'
  /** Registered and idle. Can place and receive calls. */
  | 'ready'
  /**
   * Outbound: we asked our backend to place the call, and we are waiting for
   * Exotel to ring this browser back. Nothing is ringing yet from the SDK's
   * point of view. This state has no equivalent in a normal softphone and is
   * the state most integrations forget to model.
   */
  | 'placing'
  /** Outbound: the agent leg arrived and is up; Exotel is dialling the customer. */
  | 'dialing_customer'
  /** Inbound: a genuine customer call is ringing this browser. */
  | 'ringing'
  /** Both legs up, audio flowing. */
  | 'live'
  /** Hangup in flight. */
  | 'ending'
  /** Terminal error state; call `reset()` to clear. */
  | 'failed';

export type CallDirection = 'inbound' | 'outbound';

export interface ActiveCall {
  direction: CallDirection;
  /** SIP Call-ID from the SDK (agent leg). */
  sipCallId?: string;
  /** Exotel CallSid from the Connect API response. Use this to join legs to CRM records. */
  callSid?: string;
  /** For outbound: who we dialled. For inbound: the caller. */
  peer: string;
  /** Free-form value echoed back in status callbacks. Put your CRM record id here. */
  customField?: string;
  startedAt: number;
  answeredAt?: number;
}

export interface PhoneSnapshot {
  state: PhoneState;
  registered: boolean;
  legs: CallLegs;
  call: ActiveCall | null;
  muted: boolean;
  held: boolean;
  /** Set when state === 'failed', or after a recoverable problem. */
  error: string | null;
  /** True when this tab is the one allowed to handle calls. */
  isLeader: boolean;
}

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

/**
 * What your server hands the browser at session start.
 *
 * Note what is NOT here: sipSecret. In the low-level SDK you must ship the SIP
 * password to the browser, which is why the CRM SDK exists — it exchanges a
 * short-lived token for credentials internally. If you use the low-level SDK,
 * treat this payload as a bearer credential: short TTL, per-user, revocable.
 */
export interface SessionPayload {
  userId: string;
  displayName: string;
  /** e.g. "sip:agent7f3a" */
  sipId: string;
  sipDomain: string;
  wssHost: string;
  wssPort: string;
  /** Virtual number shown to the customer as caller ID. */
  callerId: string;
  /** Which device currently receives calls. */
  activeDevice: 'sip' | 'phone';
}

export interface DialRequest {
  to: string;
  customField?: string;
}

export interface DialResponse {
  /** Exotel CallSid. Correlate the inbound agent leg against this. */
  callSid: string;
  /** Echoed back so the client can confirm what it dialled. */
  to: string;
}

/**
 * Pushed from your backend to the browser (SSE or WebSocket) after you receive
 * an Exotel status callback. This is the ONLY trustworthy source for customer
 * leg state.
 */
export interface ServerCallUpdate {
  callSid: string;
  direction: CallDirection;
  /** Exotel's coarse state. */
  callState: 'active' | 'terminal';
  /** Our derived customer leg state. */
  customerLeg: LegState;
  toNumber?: string;
  fromNumber?: string;
  totalDuration?: number;
  recordingUrl?: string;
}
