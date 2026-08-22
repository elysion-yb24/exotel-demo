import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Softphone as SoftphoneClient } from '../client/softphone';
import { TabLeader } from '../client/tabLeader';
import { Ringtone, type RingPattern } from '../client/ringtone';
import { Notifier, type NotifyState } from '../client/notify';
import type { LegState, PhoneSnapshot, ServerCallUpdate } from '../types';

/**
 * The UI is built around one idea: an agent must be able to tell, at a glance,
 * WHICH LEG is up. "Connected" on its own is a lie during an outbound call —
 * the agent's browser is connected while the customer's phone is still ringing.
 * The signal path below is the honest version of a call status indicator.
 */

const IDLE: PhoneSnapshot = {
  state: 'offline',
  registered: false,
  legs: { agent: 'down', customer: 'down' },
  call: null,
  muted: false,
  held: false,
  error: null,
  isLeader: true,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function useSoftphone() {
  const [local, setLocal] = useState<PhoneSnapshot>(IDLE);
  /** The leader's snapshot, relayed to this tab. Null in the leader itself. */
  const [mirrored, setMirrored] = useState<PhoneSnapshot | null>(null);
  const [isLeader, setIsLeader] = useState(false);
  /** Heartbeat-derived: another tab is on a call. Independent of snapshots. */
  const [peerBusy, setPeerBusy] = useState(false);
  const [session, setSession] = useState<{ userId: string; displayName: string; callerId: string | null } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const phone = useRef<SoftphoneClient | null>(null);
  const bus = useRef<TabLeader | null>(null);

  useEffect(() => {
    let leader: TabLeader | null = null;
    let events: EventSource | null = null;
    let cancelled = false;

    (async () => {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      if (!res.ok) {
        setFatal(data.message ?? 'Could not start a session.');
        return;
      }
      if (cancelled) return;

      setSession({ userId: data.userId, displayName: data.displayName, callerId: data.callerId });

      const client = new SoftphoneClient({
        accessToken: data.accessToken,
        userId: data.userId,
        onChange: (s) => {
          setLocal(s);
          // The leader is the only tab with real call state, so it publishes.
          // Followers need it to know whether a call is in progress elsewhere.
          if (bus.current?.isLeader) {
            bus.current.setBusy(isCallActive(s));
            bus.current.broadcast({ type: 'snapshot', snap: s });
          }
        },
      });
      phone.current = client;

      leader = new TabLeader({
        onLeaderChange: (nowLeader) => {
          setIsLeader(nowLeader);
          client.setLeader(nowLeader);
          // A tab that just lost leadership must stop claiming to know the
          // call state; a tab that just gained it stops mirroring.
          if (nowLeader) setMirrored(null);
        },
        onMessage: (msg) => {
          if (msg?.type === 'snapshot') setMirrored(msg.snap as PhoneSnapshot);
        },
        onPeerBusyChange: setPeerBusy,
        onHello: () => {
          // A tab just joined. Replay our state so it can describe the call in
          // progress instead of waiting for the next change.
          const s = phone.current?.snapshot();
          if (s) leader?.broadcast({ type: 'snapshot', snap: s });
        },
      });
      bus.current = leader;

      try {
        await client.connect();
      } catch (e: any) {
        setFatal(e?.message ?? 'SDK initialise failed.');
        return;
      }

      // Customer leg truth arrives from the backend, never from the SDK.
      events = new EventSource(`/api/events/${encodeURIComponent(data.userId)}`);
      events.onmessage = (e) => {
        try {
          client.applyServerUpdate(JSON.parse(e.data) as ServerCallUpdate);
        } catch {
          /* ignore keepalives */
        }
      };
    })();

    return () => {
      cancelled = true;
      events?.close();
      leader?.destroy();
      bus.current = null;
      phone.current?.disconnect();
    };
  }, []);

  // A follower has no SIP session, so its own snapshot is idle and useless for
  // display. Show the leader's instead, once it has told us anything.
  const snap = isLeader ? local : mirrored ?? local;

  return {
    snap,
    session,
    fatal,
    isLeader,
    /** True when the tab holding the call is a different one. */
    // peerBusy is the reliable signal; the mirrored snapshot only adds detail
    // (who is on the call) and may not have arrived yet.
    callElsewhere: !isLeader && (peerBusy || (!!mirrored && isCallActive(mirrored))),
    claimLeadership: () => bus.current?.claim(),
    phone: phone.current,
  };
}

/** Anything that must not be interrupted by moving the SIP registration. */
function isCallActive(s: PhoneSnapshot): boolean {
  return (
    s.legs.agent === 'up' ||
    s.state === 'placing' ||
    s.state === 'ringing' ||
    s.state === 'dialing_customer' ||
    s.state === 'live' ||
    s.state === 'ending'
  );
}

// ---------------------------------------------------------------------------
// Signal path — the signature element
// ---------------------------------------------------------------------------

function SignalPath({ legs, direction }: { legs: PhoneSnapshot['legs']; direction?: 'inbound' | 'outbound' }) {
  const seg = (s: LegState) => `seg seg--${s}`;
  return (
    <div className="path" role="img" aria-label={`Agent leg ${legs.agent}, customer leg ${legs.customer}`}>
      <div className="node">
        <span className="node__dot" data-live={legs.agent === 'up'} />
        <span className="node__label">Browser</span>
      </div>

      <div className={seg(legs.agent)}>
        <span className="seg__tag">agent leg</span>
      </div>

      <div className="node node--hub">
        <span className="node__dot" data-live={legs.agent === 'up' || legs.customer === 'up'} />
        <span className="node__label">Exotel</span>
      </div>

      <div className={seg(legs.customer)}>
        <span className="seg__tag">customer leg</span>
      </div>

      <div className="node">
        <span className="node__dot" data-live={legs.customer === 'up'} />
        <span className="node__label">Customer</span>
      </div>

      {direction && <span className="path__dir">{direction}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy for each state. Deliberately says what is true, not what is reassuring.
// ---------------------------------------------------------------------------

const STATUS: Record<PhoneSnapshot['state'], { label: string; detail: string; tone: string }> = {
  offline: { label: 'Offline', detail: 'Device not registered', tone: 'dim' },
  connecting: { label: 'Registering', detail: 'Opening SIP session', tone: 'amber' },
  ready: { label: 'Ready', detail: 'Registered and idle', tone: 'green' },
  placing: { label: 'Placing', detail: 'Waiting for Exotel to ring you back', tone: 'amber' },
  dialing_customer: { label: 'Dialling out', detail: 'You are on. Customer is ringing.', tone: 'amber' },
  ringing: { label: 'Incoming', detail: 'Customer is calling', tone: 'amber' },
  live: { label: 'Live', detail: 'Both legs connected', tone: 'green' },
  ending: { label: 'Ending', detail: 'Hanging up', tone: 'dim' },
  failed: { label: 'Failed', detail: 'See detail below', tone: 'red' },
};

// ---------------------------------------------------------------------------
// Follower notice
//
// Only one tab can hold the SIP registration, so the others need to say so
// rather than silently looking broken. Two cases, and the difference matters:
//
//   idle elsewhere    -> leadership can move here on request
//   call in progress  -> it cannot. Moving the registration mid-call means
//                        tearing down the WebRTC session, which drops the call.
//                        There is no handover mechanism in SIP for this.
// ---------------------------------------------------------------------------

function TabNotice({
  callElsewhere,
  peer,
  onClaim,
}: {
  callElsewhere: boolean;
  peer?: string;
  onClaim: () => void;
}) {
  return (
    <div className="notice" role="status">
      {callElsewhere ? (
        <>
          <strong className="notice__title">Call in progress in another tab</strong>
          <p className="notice__body">
            {peer ? <>The call with <strong>{peer}</strong> is</> : 'The call is'} being handled in the tab
            that started it. An active call can&rsquo;t be moved here — switching tabs would end it.
          </p>
        </>
      ) : (
        <>
          <strong className="notice__title">Calls are handled in another tab</strong>
          <p className="notice__body">
            This tab is watching only. Focus it, or use the button, to make it the one that rings.
          </p>
          <button className="btn" onClick={onClaim}>
            Handle calls here
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Incoming-call dialog
//
// Only reachable from state `ringing`, which a call WE placed never enters
// while autoAnswerOutbound is on. So in normal operation this dialog means a
// real person is on the line, and Decline hangs up on them — which is why
// Escape is not wired to dismiss it.
// ---------------------------------------------------------------------------

function IncomingCall({
  peer,
  direction,
  onAccept,
  onDecline,
}: {
  peer: string;
  direction?: 'inbound' | 'outbound';
  onAccept: () => void;
  onDecline: () => void;
}) {
  const accept = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    accept.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Enter accepts. Escape is deliberately unbound: dismissing this dialog
    // drops a live caller, and Escape is the key people hit by reflex.
    if (e.key === 'Enter') {
      e.preventDefault();
      onAccept();
    }
  };

  return (
    <div className="modal">
      <div
        className="modal__box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="incoming-peer"
        onKeyDown={onKeyDown}
      >
        <span className="eyebrow">{direction === 'outbound' ? 'Your own outbound leg' : 'Incoming call'}</span>
        <h2 className="modal__peer" id="incoming-peer">{peer}</h2>
        <p className="modal__note">
          {direction === 'outbound'
            ? 'This is the leg for the call you placed. The customer has not been dialled yet.'
            : 'Accepting connects your browser. The caller is already on the line.'}
        </p>
        <div className="modal__actions">
          <button ref={accept} className="btn btn--go" onClick={onAccept}>
            Accept
          </button>
          <button className="btn btn--stop" onClick={onDecline}>
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Softphone() {
  const { snap, session, fatal, isLeader, callElsewhere, claimLeadership, phone } = useSoftphone();
  const [number, setNumber] = useState('');
  const status = STATUS[snap.state];

  const dial = useCallback(() => {
    if (!number.trim() || !phone) return;
    phone.dial(number.trim()).catch(() => {});
  }, [number, phone]);

  // -------------------------------------------------------------------------
  // Ring + notify
  // -------------------------------------------------------------------------

  const ring = useRef<Ringtone | null>(null);
  const notifier = useRef<Notifier | null>(null);
  const [notifyState, setNotifyState] = useState<NotifyState>('default');

  // Ringer choices are per-agent habits, so they outlive the tab.
  const [silent, setSilent] = useState(() => localStorage.getItem('ring.silent') === '1');
  const [pattern, setPattern] = useState<RingPattern>(
    () => (localStorage.getItem('ring.pattern') as RingPattern | null) ?? 'marimba',
  );

  // The notification action handler fires long after render, so read the phone
  // through a ref rather than closing over a stale one.
  const phoneRef = useRef(phone);
  phoneRef.current = phone;

  useEffect(() => {
    // `pattern` here is the persisted initial value; the effect below keeps it
    // in sync afterwards without tearing down the audio graph.
    ring.current = new Ringtone(pattern);
    const n = new Notifier();
    notifier.current = n;
    setNotifyState(n.state);

    n.register((action) => {
      if (action === 'accept') phoneRef.current?.answer();
      if (action === 'decline') phoneRef.current?.decline();
    });

    // Autoplay policy suspends an AudioContext built without a gesture, so the
    // first ring of a session can be silent. Any click unlocks it.
    const unlock = () => ring.current?.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      ring.current?.dispose();
      n.dispose();
    };
  }, []);

  const ringing = snap.state === 'ringing';

  // -------------------------------------------------------------------------
  // Reload / close guard
  //
  // A reload or tab close destroys the RTCPeerConnection, the media stream and
  // the SIP dialog — the call ENDS, it does not merely disappear from the UI.
  // There is no way to hand a live WebRTC session to a new document, so the
  // only real protection is to make the agent confirm.
  //
  // Covers anything in flight, not just connected audio: a call being placed or
  // ringing is equally lost, and equally annoying to lose.
  // -------------------------------------------------------------------------
  const inFlight =
    snap.legs.agent === 'up' ||
    snap.state === 'placing' ||
    snap.state === 'ringing' ||
    snap.state === 'dialing_customer' ||
    snap.state === 'live';

  useEffect(() => {
    if (!inFlight) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // returnValue is deprecated and its text is ignored — browsers show their
      // own wording — but several still require it to be set before they will
      // show the prompt at all. Assigning it is deliberate, not stale code.
      e.returnValue = 'You are on a call. Reloading will end it.';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [inFlight]);

  useEffect(() => {
    // Only the leader rings. Followers show the call visually and, when
    // hidden, raise a notification — but two tabs ringing at once is the
    // exact confusion this coordination exists to prevent.
    if (ringing && isLeader && !silent) {
      void ring.current?.start();
      notifier.current?.ringing(snap.call?.peer ?? 'Unknown');
    } else {
      ring.current?.stop();
      notifier.current?.stopRinging();
    }
    // Stop the noise if this tab loses leadership mid-ring.
  }, [ringing, isLeader, silent, snap.call?.peer]);

  useEffect(() => {
    ring.current?.setPattern(pattern);
    localStorage.setItem('ring.pattern', pattern);
  }, [pattern]);

  useEffect(() => {
    localStorage.setItem('ring.silent', silent ? '1' : '0');
  }, [silent]);

  /** Preview the selected ring outside a call, so it can be picked deliberately. */
  const preview = useCallback(() => {
    const r = ring.current;
    if (!r) return;
    void r.start();
    setTimeout(() => r.stop(), 2600);
  }, []);

  const askNotify = useCallback(async () => {
    const s = await notifier.current?.requestPermission();
    if (s) setNotifyState(s);
  }, []);

  if (fatal) {
    return (
      <main className="shell">
        <div className="card card--stop">
          <h1 className="stop__title">Cannot start</h1>
          <p className="stop__body">{fatal}</p>
          <p className="stop__hint">Run <code>npm run smoke</code> to find which link in the chain is missing.</p>
        </div>
      </main>
    );
  }

  const busy = snap.state !== 'ready' && snap.state !== 'offline' && snap.state !== 'failed';

  return (
    <main className="shell">
      <div className="card">
        <header className="head">
          <div>
            <span className="eyebrow">Agent softphone</span>
            <h1 className="head__name">{session?.displayName ?? '—'}</h1>
          </div>
          <div className="head__meta">
            <span className={`pill pill--${status.tone}`}>{status.label}</span>
            {!isLeader && <span className="pill pill--dim">Not handling calls</span>}
          </div>
        </header>

        <p className="detail">{status.detail}</p>

        {!isLeader && (
          <TabNotice callElsewhere={callElsewhere} peer={snap.call?.peer} onClaim={claimLeadership} />
        )}

        <SignalPath legs={snap.legs} direction={snap.call?.direction} />

        {snap.call && (
          <dl className="facts">
            <div>
              <dt>{snap.call.direction === 'outbound' ? 'Dialling' : 'From'}</dt>
              <dd>{snap.call.peer}</dd>
            </div>
            <div>
              <dt>Caller ID</dt>
              <dd>{session?.callerId ?? 'not set'}</dd>
            </div>
            <div>
              <dt>CallSid</dt>
              <dd className="facts__sid">{snap.call.callSid ?? 'pending'}</dd>
            </div>
          </dl>
        )}

        {snap.error && <p className="alert">{snap.error}</p>}

        {!busy && (
          <div className="dialer">
            <input
              className="dialer__input"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && dial()}
              placeholder="Number to call"
              inputMode="tel"
              disabled={!snap.registered || !isLeader}
            />
            <button className="btn btn--go" onClick={dial} disabled={!snap.registered || !isLeader || !number.trim()}>
              Call
            </button>
          </div>
        )}

        <div className="controls">
          {/* While ringing, the dialog owns both choices — a second Hang up
              button here would be a third way to do the same thing. */}
          {busy && snap.state !== 'ringing' && (
            <button className="btn btn--stop" onClick={() => phone?.hangup()}>
              Hang up
            </button>
          )}
          {(snap.state === 'live' || snap.state === 'dialing_customer') && (
            <>
              <button className="btn" data-on={snap.muted} onClick={() => phone?.toggleMute()}>
                {snap.muted ? 'Unmute' : 'Mute'}
              </button>
              <button className="btn" data-on={snap.held} onClick={() => phone?.toggleHold()}>
                {snap.held ? 'Resume' : 'Hold'}
              </button>
            </>
          )}
          {snap.state === 'failed' && (
            <button className="btn" onClick={() => phone?.reset()}>
              Clear
            </button>
          )}
        </div>

        {snap.state === 'live' && (
          <div className="keypad">
            {['1','2','3','4','5','6','7','8','9','*','0','#'].map((d) => (
              <button key={d} className="key" onClick={() => phone?.sendDtmf(d)}>
                {d}
              </button>
            ))}
          </div>
        )}

        <div className="prefs">
          <button
            className="prefs__btn"
            data-on={!silent}
            onClick={() => setSilent((s) => !s)}
            aria-pressed={!silent}
          >
            Ringer {silent ? 'off' : 'on'}
          </button>

          <button
            className="prefs__btn"
            onClick={() => setPattern((p) => (p === 'marimba' ? 'classic' : 'marimba'))}
            disabled={silent}
          >
            Tone: {pattern === 'marimba' ? 'Marimba' : 'Telephone'}
          </button>

          {!ringing && (
            <button className="prefs__btn" onClick={preview} disabled={silent}>
              Preview
            </button>
          )}

          {notifyState === 'default' && (
            <button className="prefs__btn" onClick={askNotify}>
              Enable notifications
            </button>
          )}
          {notifyState === 'granted' && <span className="prefs__note">Notifies when this tab is hidden</span>}
          {notifyState === 'denied' && <span className="prefs__note">Notifications blocked in browser settings</span>}
          {notifyState === 'unsupported' && <span className="prefs__note">Notifications unsupported here</span>}
        </div>
      </div>

      {snap.state === 'ringing' && isLeader && (
        <IncomingCall
          peer={snap.call?.peer ?? 'Unknown'}
          direction={snap.call?.direction}
          onAccept={() => phone?.answer()}
          onDecline={() => phone?.decline()}
        />
      )}

      <p className="foot">
        Outbound calls arrive at this client as an <code>incoming</code> event and are auto-answered,
        so this dialog only appears for calls you did not place.
        The customer leg updates only when a status callback reaches the backend.
      </p>
    </main>
  );
}
