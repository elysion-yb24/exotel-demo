/**
 * Tab coordination for the softphone.
 *
 * Exotel's docs are explicit that this is the integrator's job: every tab that
 * loads the SDK registers its SIP endpoint, and every one of them gets the
 * incoming-call alert. Without coordination an agent with three CRM tabs open
 * hears three rings and races themselves to answer.
 *
 * THE MODEL
 *
 *   leader     = holds the Web Lock. Owns the SIP registration, the WebRTC
 *                audio and the ringtone. STICKY: it keeps the job until the tab
 *                dies or the agent explicitly moves it.
 *   followers  = no registration. They mirror the leader's snapshot and drive
 *                the call by sending it commands, so the agent can work from
 *                whichever tab they are looking at without the registration
 *                ever moving.
 *
 * WHY WEB LOCKS AND NOT A HEARTBEAT
 *
 * The obvious design is a heartbeat over BroadcastChannel with a liveness
 * expiry, and it is wrong. Browsers clamp `setInterval` in hidden tabs to 1s,
 * drop to roughly one wake per minute after five minutes, and eventually freeze
 * the page outright — at which point timers stop and BroadcastChannel messages
 * are dropped rather than queued. Any expiry short enough to notice a closed
 * tab promptly is far shorter than the interval a backgrounded tab can actually
 * keep, so healthy hidden tabs get declared dead. Two tabs then both believe
 * they lead, both register, and both ring: the exact bug this file exists to
 * prevent, appearing only once a tab has been in the background for a while.
 *
 * A Web Lock has no such window. The browser releases it precisely when the
 * holding document goes away, and keeps holding it across throttling, freezing
 * and bfcache. Liveness stops being something we estimate.
 *
 * The BroadcastChannel remains, but carries only application messages —
 * snapshots and commands. Nothing about who leads depends on a message
 * arriving on time.
 *
 * WHY LEADERSHIP DOES NOT FOLLOW FOCUS
 *
 * Moving the registration to whichever tab has focus means every alt-tab tears
 * one SIP registration down and builds another. Each takes the SDK's 500ms plus
 * a round trip, so switching tabs leaves a window in which NO tab is registered
 * and an incoming call is simply missed — and rapid switching interleaves the
 * in-flight register and unregister into a wedged state. The ringtone is a
 * plain `<audio>` element and is audible from a hidden tab, so there is nothing
 * to gain by moving the session. Followers mirror and command instead; the
 * registration stays put.
 */

import type { PhoneSnapshot } from '../types';

const LOCK_NAME = 'exotel-softphone-leader';
const CHANNEL_NAME = 'exotel-softphone-bus';

/**
 * Grace between announcing a handover and actually letting go, so the tabs told
 * to stand aside have left the lock queue first.
 */
const YIELD_GRACE_MS = 150;

/** How long a stood-down tab stays out of the queue. Must exceed the grace. */
const STAND_DOWN_MS = 500;

/** Base backoff after the lock manager errors. Multiplied by the failure count. */
const LOCK_RETRY_MS = 1_000;

/** Consecutive lock failures before we give up on coordinating and just lead. */
const LOCK_FAILURE_LIMIT = 5;

/** Things a follower can ask the leader to do on its behalf. */
export type TabCommand =
  | { cmd: 'answer' }
  | { cmd: 'decline' }
  | { cmd: 'hangup' }
  | { cmd: 'mute' }
  | { cmd: 'hold' }
  | { cmd: 'reset' }
  | { cmd: 'dtmf'; digit: string }
  | { cmd: 'dial'; to: string };

type BusMessage =
  | { type: 'hello'; from: string }
  | { type: 'snapshot'; from: string; snap: PhoneSnapshot }
  | { type: 'command'; from: string; command: TabCommand }
  | { type: 'claim'; from: string }
  | { type: 'standdown'; from: string; winner: string };

export interface TabLeaderOptions {
  /** Fires once on startup with the initial verdict, then on every change. */
  onLeaderChange: (isLeader: boolean) => void;
  /** Follower side: the leader's current state. */
  onSnapshot?: (snap: PhoneSnapshot) => void;
  /** Leader side: a follower is asking us to act. */
  onCommand?: (command: TabCommand) => void;
  /**
   * Leader side: someone wants our current state. Fires when a tab starts up
   * and again whenever one becomes visible, so a tab that was asleep through a
   * call does not come back showing what was true before it slept.
   */
  onHello?: () => void;
  /** No Web Locks in this browser. We lead unconditionally; say so in the UI. */
  onUnsupported?: () => void;
}

export class TabLeader {
  readonly id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  private channel: BroadcastChannel | null = null;
  private leader = false;
  private destroyed = false;

  /**
   * Whether a verdict has ever been published. Without this a tab whose first
   * result is `false` never fires the callback — `false` is also the initial
   * value — so the softphone never hears "you are not the leader" and falls
   * back to whatever it assumed.
   */
  private announced = false;

  /** Resolving this releases the Web Lock. Non-null only while we hold it. */
  private release: (() => void) | null = null;
  /** Withdraws a QUEUED lock request. Null once the lock has been granted. */
  private queued: AbortController | null = null;
  /** While set, we deliberately stay out of the queue so another tab can win. */
  private standDownUntil = 0;

  /** A call is in progress here. The registration cannot be handed over. */
  private busy = false;

  private readonly supported =
    typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';

  constructor(private opts: TabLeaderOptions) {
    this.openChannel();

    // `pagehide` rather than `beforeunload`: beforeunload also fires on paths
    // that end in the page being kept alive in the bfcache, and tearing down
    // there leaves a restored page with a closed channel and no lock request —
    // permanently invisible to the other tabs and unable to ever lead again.
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    if (!this.supported) {
      // Nothing safe to do but lead. Better one tab that works than an app that
      // refuses to ring at all; the UI reports the caveat.
      this.opts.onUnsupported?.();
      this.setLeader(true);
      return;
    }

    void this.race();
    this.send({ type: 'hello', from: this.id });
    // Publish the starting verdict. `race()` corrects it the moment the lock is
    // granted, which for the first tab open is within a task or two.
    this.setLeader(false);
  }

  get isLeader(): boolean {
    return this.leader;
  }

  get locksSupported(): boolean {
    return this.supported;
  }

  /**
   * Ask for the registration to move to this tab.
   *
   * Deliberately not a guarantee. The current leader refuses while a call is in
   * progress, because moving a registration mid-call tears down the WebRTC
   * session and drops the call — SIP has no handover for this.
   */
  claim(): void {
    if (this.leader) return;
    this.send({ type: 'claim', from: this.id });
  }

  /** Tell the coordinator a call is in progress here, freezing handover. */
  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /** Leader side: publish current state to the followers. */
  publish(snap: PhoneSnapshot): void {
    if (!this.leader) return;
    this.send({ type: 'snapshot', from: this.id, snap });
  }

  /** Follower side: ask the leader to act. */
  command(command: TabCommand): void {
    if (this.leader) return;
    this.send({ type: 'command', from: this.id, command });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.letGo();
    this.queued?.abort();
    this.queued = null;
    this.closeChannel();
    // Drop the flag directly rather than through setLeader(). The lock has been
    // handed on, so continuing to answer `isLeader` with true would let a
    // torn-down coordinator claim to own a registration that has already moved.
    // But this is a teardown, not a transition: firing onLeaderChange here
    // would push a state update into a component that is unmounting, and the
    // caller is already tearing the softphone down alongside us.
    this.leader = false;
  }

  // ---------------------------------------------------------------------------
  // Election
  // ---------------------------------------------------------------------------

  /**
   * Sit in the lock queue for as long as this tab lives.
   *
   * A queued request is the whole liveness mechanism: when the holder's
   * document goes away the browser grants the lock to the next waiter
   * immediately, with no polling and nothing to expire. Grants are FIFO, so
   * after a voluntary release we go to the back of the queue rather than
   * instantly reclaiming what we just gave up.
   */
  private async race(): Promise<void> {
    let failures = 0;

    while (!this.destroyed) {
      if (this.standDownUntil > Date.now()) {
        await sleep(this.standDownUntil - Date.now());
        continue;
      }

      const queued = new AbortController();
      this.queued = queued;

      try {
        await navigator.locks.request(LOCK_NAME, { signal: queued.signal }, async () => {
          // Granted. The signal only ever cancelled the wait, so drop it —
          // from here the lock is released by resolving the held promise.
          this.queued = null;
          if (this.destroyed) return;
          // Never let a downstream exception escape: throwing out of the
          // callback releases the lock, which would hand the registration to
          // another tab because of a render error over here.
          try {
            this.setLeader(true);
          } catch (err) {
            console.error('[tabLeader] leadership handler threw', err);
          }
          await new Promise<void>((resolve) => {
            this.release = resolve;
          });
        });
        failures = 0;
      } catch (err) {
        // AbortError is us withdrawing from the queue on purpose, either to
        // clear the way for a specific tab or because we are shutting down.
        if ((err as DOMException | undefined)?.name !== 'AbortError') {
          // Something is wrong with the lock manager itself. Back off and try
          // again rather than seizing leadership on the first hiccup — every
          // tab would reach the same conclusion at the same moment and they
          // would all register.
          failures += 1;
          if (failures >= LOCK_FAILURE_LIMIT) {
            console.error('[tabLeader] lock unusable, leading uncoordinated', err);
            this.opts.onUnsupported?.();
            this.setLeader(true);
            return;
          }
          this.release = null;
          this.queued = null;
          this.setLeader(false);
          await sleep(LOCK_RETRY_MS * failures);
          continue;
        }
      }

      this.release = null;
      this.queued = null;
      if (this.destroyed) return;
      this.setLeader(false);
    }
  }

  /** Release the lock if we hold it. Safe to call when we do not. */
  private letGo(): void {
    const release = this.release;
    this.release = null;
    release?.();
  }

  private setLeader(next: boolean): void {
    if (next === this.leader && this.announced) return;
    this.leader = next;
    this.announced = true;
    this.opts.onLeaderChange(next);
  }

  /**
   * Hand the registration to a specific tab.
   *
   * Grants are FIFO, so simply releasing would give the lock to the tab that
   * has waited longest rather than the one that asked. Every other follower is
   * told to leave the queue first, which leaves the claimant alone in it. The
   * aborts are asynchronous, hence the grace period before letting go; if one
   * loses the race the wrong tab takes over and the agent clicks again, which
   * is a far better failure than dropping a call.
   */
  private async yieldTo(winner: string): Promise<void> {
    if (!this.leader || this.busy) return;
    this.send({ type: 'standdown', from: this.id, winner });
    // Stay out ourselves too, or we would just rejoin ahead of the claimant.
    this.standDownUntil = Date.now() + STAND_DOWN_MS;
    await sleep(YIELD_GRACE_MS);
    this.letGo();
  }

  // ---------------------------------------------------------------------------
  // Bus
  // ---------------------------------------------------------------------------

  private openChannel(): void {
    if (this.channel || this.destroyed) return;
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (e: MessageEvent<BusMessage>) => this.onMessage(e.data);
  }

  private closeChannel(): void {
    try {
      this.channel?.close();
    } catch {
      /* already gone */
    }
    this.channel = null;
  }

  private send(msg: BusMessage): void {
    this.openChannel();
    try {
      this.channel?.postMessage(msg);
    } catch {
      // The channel dies with the document during unload. Nothing to salvage.
    }
  }

  private onMessage(msg: BusMessage | undefined): void {
    if (!msg || msg.from === this.id || this.destroyed) return;

    switch (msg.type) {
      case 'hello':
        // Only the leader holds real state, so only it answers.
        if (this.leader) this.opts.onHello?.();
        return;

      case 'snapshot':
        if (!this.leader) this.opts.onSnapshot?.(msg.snap);
        return;

      case 'command':
        if (this.leader) this.opts.onCommand?.(msg.command);
        return;

      case 'claim':
        void this.yieldTo(msg.from);
        return;

      case 'standdown':
        // Someone else is being handed the registration. Get out of the queue
        // so they are the ones who get it.
        if (msg.winner !== this.id && !this.leader) {
          this.standDownUntil = Date.now() + STAND_DOWN_MS;
          this.queued?.abort();
        }
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Page lifecycle
  // ---------------------------------------------------------------------------

  private onPageHide = (e: PageTransitionEvent) => {
    // persisted === true means the page is going into the bfcache and may come
    // back intact. Tearing down there is what strands a restored tab with a
    // closed channel and no lock request. The Web Lock is held by the document
    // and survives the freeze, so a bfcached leader correctly keeps the job.
    if (!e.persisted) this.destroy();
  };

  private onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted || this.destroyed) return;
    // Restored from bfcache. The channel should still be open, but reopen
    // defensively and re-sync: broadcasts sent while we were frozen were
    // dropped, not queued, so our mirrored state is stale by exactly the length
    // of the nap.
    this.openChannel();
    this.resync();
  };

  private onVisibilityChange = () => {
    if (document.hidden || this.destroyed) return;
    this.resync();
  };

  /**
   * Re-establish a shared view after this tab was asleep.
   *
   * A follower asks the leader for current state, because anything it received
   * while hidden may have been dropped — this is what stops a returning tab
   * from showing "call in progress" for a call that ended ten minutes ago. A
   * leader republishes for the same reason, on behalf of followers that were
   * asleep at the same time.
   */
  private resync(): void {
    if (this.leader) this.opts.onHello?.();
    else this.send({ type: 'hello', from: this.id });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
