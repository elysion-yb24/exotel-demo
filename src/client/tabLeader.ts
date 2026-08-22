/**
 * Tab coordination over BroadcastChannel: leader election plus a message bus.
 *
 * Exotel's docs are explicit that this is the integrator's job. Every tab that
 * loads the SDK registers its SIP endpoint, and every one of them gets the
 * incoming call alert. Without coordination an agent with three CRM tabs open
 * hears three rings and races themselves to answer.
 *
 * THE MODEL
 *
 *   leader      = owns the SIP registration. It alone rings and carries audio.
 *   followers   = no registration. They mirror the leader's state so the agent
 *                 sees the call in whichever tab they are looking at, and can
 *                 accept or decline from there by asking the leader to act.
 *
 * Leadership follows FOCUS, so the tab you are actually looking at is the one
 * that rings — but it is FROZEN while a call is in progress, because moving a
 * registration mid-call means dropping the call. With no tab focused, the
 * incumbent keeps it.
 */

const CHANNEL = 'exotel-softphone-leader';
const HEARTBEAT_MS = 500;
const EXPIRY_MS = 1600;

/**
 * Listen before claiming.
 *
 * A brand-new tab's first tick has an empty peer map, so it would elect itself
 * even when an older tab is already leading — then get corrected a heartbeat
 * later, after it has already asked the SDK to register. Waiting means the
 * first verdict is cast with other tabs' heartbeats counted. A lone tab pays
 * this delay once, which is unavoidable: being alone cannot be established
 * without listening.
 */
const LISTEN_FIRST_MS = HEARTBEAT_MS * 2 + 100;

interface Peer {
  at: number;
  focused: boolean;
  /** When this tab last gained focus. Most recent focus wins the election. */
  focusedAt: number;
  /** A call is in progress here. Freezes the election. */
  busy: boolean;
  /** This tab believes it is currently the leader. */
  leader: boolean;
}

export interface TabLeaderOptions {
  onLeaderChange: (isLeader: boolean) => void;
  /** Application messages from other tabs (snapshots, commands). */
  onMessage?: (msg: any, fromId: string) => void;
  /**
   * Another tab reports a call in progress. Derived from heartbeats, not from
   * relayed snapshots, so a tab that loads mid-call knows within one heartbeat
   * instead of waiting for the leader's next state change.
   */
  onPeerBusyChange?: (busy: boolean) => void;
  /** A tab just joined and is asking for current state. Leader should reply. */
  onHello?: () => void;
}

export class TabLeader {
  private id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private channel: BroadcastChannel;
  private peers = new Map<string, Peer>();
  private timer: ReturnType<typeof setInterval>;
  private leader = false;
  /**
   * Whether a verdict has ever been published. Without this, a tab whose first
   * election result is `false` never fires the callback — because `false` is
   * also the initial value — so the softphone never hears "you are not the
   * leader" and falls back to whatever it assumed.
   */
  private announced = false;
  private readonly startedAt = Date.now();

  private focused = typeof document !== 'undefined' && document.hasFocus() && !document.hidden;
  private focusedAt = this.focused ? Date.now() : 0;
  private busy = false;

  constructor(private opts: TabLeaderOptions) {
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (e) => {
      const { type, id, peer, payload } = e.data ?? {};
      if (!id || id === this.id) return;

      if (type === 'alive' && peer) {
        this.peers.set(id, { ...peer, at: Date.now() });
        this.notifyPeerBusy();
      } else if (type === 'bye') {
        this.peers.delete(id);
        this.notifyPeerBusy();
      } else if (type === 'hello') {
        // Only the leader holds real state, so only it should answer.
        if (this.leader) this.opts.onHello?.();
      } else if (type === 'app') {
        this.opts.onMessage?.(payload, id);
      }
    };

    // Announce arrival so an in-progress call is reported to us immediately
    // rather than at the leader's next state change.
    this.channel.postMessage({ type: 'hello', id: this.id });

    window.addEventListener('focus', this.onFocus);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('beforeunload', this.onUnload);

    this.timer = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.tick();
  }

  get isLeader() {
    return this.leader;
  }

  /**
   * Ask to handle calls in this tab.
   *
   * Deliberately not a guarantee: rule 1 of the election still wins, so a tab
   * with a call in progress keeps the registration and this request is ignored.
   * That is the point — an ongoing call cannot be moved without dropping it.
   */
  claim(): void {
    this.focused = true;
    this.focusedAt = Date.now();
    this.tick();
  }

  /** Tell the coordinator a call is in progress here, freezing the election. */
  setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.tick();
  }

  /** Send an application message to every other tab. */
  broadcast(payload: unknown): void {
    this.channel.postMessage({ type: 'app', id: this.id, payload });
  }

  destroy(): void {
    clearInterval(this.timer);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('beforeunload', this.onUnload);
    try {
      this.channel.postMessage({ type: 'bye', id: this.id });
      this.channel.close();
    } catch {
      /* channel already gone */
    }
  }

  // -------------------------------------------------------------------------

  private onFocus = () => this.setFocused(true);
  private onBlur = () => this.setFocused(false);
  private onVisibility = () => this.setFocused(document.hasFocus() && !document.hidden);
  private onUnload = () => this.destroy();

  private setFocused(focused: boolean) {
    if (this.focused === focused) return;
    this.focused = focused;
    if (focused) this.focusedAt = Date.now();
    // Re-run immediately: the point of focus-following leadership is that it
    // feels instant when the agent switches tabs.
    this.tick();
  }

  /** True when some OTHER live tab is on a call. */
  private peerBusy = false;

  private notifyPeerBusy() {
    const cutoff = Date.now() - EXPIRY_MS;
    let busy = false;
    for (const p of this.peers.values()) if (p.at >= cutoff && p.busy) busy = true;
    if (busy !== this.peerBusy) {
      this.peerBusy = busy;
      this.opts.onPeerBusyChange?.(busy);
    }
  }

  private self(): Peer {
    return {
      at: Date.now(),
      focused: this.focused,
      focusedAt: this.focusedAt,
      busy: this.busy,
      leader: this.leader,
    };
  }

  private tick() {
    const me = this.self();
    // Announce first: peers should know about us even while we withhold our
    // own verdict during the listen window.
    this.channel.postMessage({ type: 'alive', id: this.id, peer: me });

    const cutoff = Date.now() - EXPIRY_MS;
    for (const [id, p] of this.peers) if (p.at < cutoff) this.peers.delete(id);
    this.notifyPeerBusy();

    if (Date.now() - this.startedAt < LISTEN_FIRST_MS && this.peers.size === 0 && !this.leader) {
      return;
    }

    const winner = this.elect(new Map([...this.peers, [this.id, me]]));
    const isLeader = winner === this.id;
    if (isLeader !== this.leader || !this.announced) {
      this.leader = isLeader;
      this.announced = true;
      this.opts.onLeaderChange(isLeader);
    }
  }

  /**
   * Same inputs on every tab produce the same winner, so tabs agree without a
   * negotiation protocol. Ordered by precedence:
   *
   *   1. A tab on a call keeps it. Registration cannot move mid-call.
   *   2. Otherwise the most recently focused tab — "the one I am looking at".
   *   3. Otherwise the incumbent, so an unfocused window does not hand off.
   *   4. Otherwise lowest id, an arbitrary but stable tiebreak.
   */
  private elect(all: Map<string, Peer>): string {
    const ids = [...all.keys()].sort();
    const by = (pick: (p: Peer) => boolean) => ids.filter((id) => pick(all.get(id)!));

    const busy = by((p) => p.busy);
    if (busy.length) return busy[0]!;

    const focused = by((p) => p.focused);
    if (focused.length) {
      return focused.reduce((best, id) =>
        all.get(id)!.focusedAt > all.get(best)!.focusedAt ? id : best,
      );
    }

    const incumbent = by((p) => p.leader);
    if (incumbent.length) return incumbent[0]!;

    return ids[0]!;
  }
}
