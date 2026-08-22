/**
 * Exercises TabLeader against a Web Locks shim that models the browser's
 * FIFO grant order, plus Node's real BroadcastChannel.
 */
import assert from 'node:assert';
import { BroadcastChannel } from 'node:worker_threads';

// --- shims -----------------------------------------------------------------

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function makeLockManager() {
  const queues = new Map<string, any[]>();
  const held = new Map<string, boolean>();

  function pump(name: string) {
    if (held.get(name)) return;
    const q = queues.get(name) ?? [];
    let entry;
    while ((entry = q.shift())) if (!entry.cancelled) break;
    if (!entry || entry.cancelled) return;
    held.set(name, true);
    entry.started = true;
    Promise.resolve()
      .then(() => entry.cb({ name, mode: 'exclusive' }))
      .then(
        (v) => { held.set(name, false); entry.resolve(v); pump(name); },
        (e) => { held.set(name, false); entry.reject(e); pump(name); },
      );
  }

  return {
    request(name: string, opts: any, cb?: any) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      return new Promise((resolve, reject) => {
        const entry: any = { cb, resolve, reject, cancelled: false, started: false };
        const signal = opts?.signal;
        if (signal) {
          if (signal.aborted) return reject(abortError());
          signal.addEventListener('abort', () => {
            if (entry.started) return;
            entry.cancelled = true;
            reject(abortError());
          });
        }
        const q = queues.get(name) ?? [];
        q.push(entry);
        queues.set(name, q);
        pump(name);
      });
    },
  };
}

const listeners = { window: [] as any[], document: [] as any[] };
(globalThis as any).window = {
  addEventListener: (t: string, f: any) => listeners.window.push([t, f]),
  removeEventListener: () => {},
};
(globalThis as any).document = {
  hidden: false,
  addEventListener: (t: string, f: any) => listeners.document.push([t, f]),
  removeEventListener: () => {},
};
Object.defineProperty(globalThis, 'navigator', {
  value: { locks: makeLockManager() },
  configurable: true,
  writable: true,
});
(globalThis as any).BroadcastChannel = BroadcastChannel;

const { TabLeader } = await import('../src/client/tabLeader');

// --- helpers ---------------------------------------------------------------

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const SNAP: any = {
  state: 'ready', registered: true, legs: { agent: 'down', customer: 'down' },
  call: null, muted: false, held: false, error: null, isLeader: true,
};

function makeTab(name: string, log: string[]) {
  const seen: any = { snapshots: [], commands: [], hellos: 0 };
  const t = new TabLeader({
    onLeaderChange: (l: boolean) => log.push(`${name}:${l ? 'LEAD' : 'follow'}`),
    onSnapshot: (s: any) => seen.snapshots.push(s),
    onCommand: (c: any) => seen.commands.push(c),
    onHello: () => { seen.hellos++; },
  });
  return { name, t, seen };
}

let failures = 0;
function check(label: string, fn: () => void) {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e: any) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
}

// --- tests -----------------------------------------------------------------

const log: string[] = [];
const a = makeTab('A', log);
await tick();
const b = makeTab('B', log);
const c = makeTab('C', log);
await tick(150);

const leaders = () => [a, b, c].filter((x) => x.t.isLeader).map((x) => x.name);

console.log('\n1. exactly one leader among three tabs');
check('one leader', () => assert.deepEqual(leaders(), ['A']));
check('A announced LEAD', () => assert.ok(log.includes('A:LEAD')));
check('B announced follow', () => assert.ok(log.includes('B:follow')));

console.log('\n2. leader publishes, followers mirror');
a.t.publish(SNAP);
await tick();
check('B got snapshot', () => assert.equal(b.seen.snapshots.length, 1));
check('C got snapshot', () => assert.equal(c.seen.snapshots.length, 1));
check('follower publish is a no-op', () => {
  const before = a.seen.snapshots.length;
  b.t.publish(SNAP);
  assert.equal(a.seen.snapshots.length, before);
});

console.log('\n3. follower commands reach the leader only');
b.t.command({ cmd: 'answer' });
await tick();
check('A got the command', () => assert.deepEqual(a.seen.commands, [{ cmd: 'answer' }]));
check('C did not', () => assert.equal(c.seen.commands.length, 0));

console.log('\n4. hello on a new tab pulls state from the leader');
const helloBefore = a.seen.hellos;
const d = makeTab('D', log);
await tick(150);
check('leader was asked for state', () => assert.ok(a.seen.hellos > helloBefore));
check('D is a follower', () => assert.equal(d.t.isLeader, false));

console.log('\n5. targeted handover: C claims, C wins (not B, who queued first)');
c.t.claim();
await tick(900);
check('exactly one leader', () => assert.equal([a, b, c, d].filter((x) => x.t.isLeader).length, 1));
check('C is the leader', () => assert.equal(c.t.isLeader, true));
check('A stepped down', () => assert.equal(a.t.isLeader, false));

console.log('\n6. a busy leader refuses to hand over');
c.t.setBusy(true);
a.t.claim();
await tick(900);
check('C kept the registration', () => assert.equal(c.t.isLeader, true));
check('A did not take it', () => assert.equal(a.t.isLeader, false));
c.t.setBusy(false);

console.log('\n7. closing the leader promotes exactly one successor');
c.t.destroy();
await tick(300);
const after = [a, b, d].filter((x) => x.t.isLeader);
check('exactly one successor', () => assert.equal(after.length, 1));
check('successor is not C', () => assert.equal(c.t.isLeader, false));

console.log('\n8. teardown leaves nobody claiming leadership');
for (const x of [a, b, d]) x.t.destroy();
await tick(200);
check('no leaders left', () => assert.equal([a, b, d].filter((x) => x.t.isLeader).length, 0));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
