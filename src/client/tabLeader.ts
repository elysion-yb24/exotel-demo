/**
 * Tab leader election over BroadcastChannel.
 *
 * Exotel's docs are explicit that this is the integrator's job: every tab that
 * loads the SDK registers its SIP endpoint and every one of them gets the
 * incoming call alert. Without election, an agent with three CRM tabs open
 * hears three rings and races themselves to answer.
 *
 * Cheapest correct approach: lowest live tab id wins. Heartbeats expire dead
 * tabs so closing the leader promotes a successor within ~1.5s.
 */

const CHANNEL = 'exotel-softphone-leader';
const HEARTBEAT_MS = 500;
const EXPIRY_MS = 1600;

export class TabLeader {
  private id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private channel: BroadcastChannel;
  private peers = new Map<string, number>();
  private timer: ReturnType<typeof setInterval>;
  private leader = false;

  constructor(private onChange: (isLeader: boolean) => void) {
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (e) => {
      const { type, id } = e.data ?? {};
      if (type === 'alive' && id) this.peers.set(id, Date.now());
      if (type === 'bye' && id) this.peers.delete(id);
    };

    this.timer = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.tick();
    window.addEventListener('beforeunload', () => this.destroy());
  }

  private tick() {
    this.channel.postMessage({ type: 'alive', id: this.id });

    const cutoff = Date.now() - EXPIRY_MS;
    for (const [id, seen] of this.peers) if (seen < cutoff) this.peers.delete(id);

    const lowest = [...this.peers.keys(), this.id].sort()[0];
    const isLeader = lowest === this.id;
    if (isLeader !== this.leader) {
      this.leader = isLeader;
      this.onChange(isLeader);
    }
  }

  get isLeader() {
    return this.leader;
  }

  destroy() {
    clearInterval(this.timer);
    this.channel.postMessage({ type: 'bye', id: this.id });
    this.channel.close();
  }
}
