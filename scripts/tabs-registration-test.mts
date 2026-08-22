/**
 * Exercises the registration lifecycle: the wake-from-background recovery that
 * the reported bug is about, plus the demote-mid-flight teardown.
 */
import assert from 'node:assert';

// --- shims -----------------------------------------------------------------

function bus() {
  const ls = new Map<string, any[]>();
  return {
    hidden: false,
    addEventListener: (t: string, f: any) => ls.set(t, [...(ls.get(t) ?? []), f]),
    removeEventListener: (t: string, f: any) =>
      ls.set(t, (ls.get(t) ?? []).filter((x) => x !== f)),
    fire: (t: string, e: any = {}) => (ls.get(t) ?? []).forEach((f) => f(e)),
  };
}
const doc: any = bus();
const win: any = bus();
// The Exotel core SDK touches the DOM at import time, so this has to be
// enough of a document to survive `new Audio()`-style setup.
const el = () => ({
  play: () => Promise.resolve(), pause: () => {}, load: () => {}, remove: () => {},
  setAttribute: () => {}, appendChild: () => {}, addEventListener: () => {}, style: {},
});
doc.createElement = el;
doc.getElementById = () => null;
doc.body = el();
(globalThis as any).document = doc;
(globalThis as any).window = win;
(globalThis as any).Audio = el;
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node', mediaDevices: {} },
  configurable: true,
  writable: true,
});

const { Softphone } = await import('../src/client/softphone');

// --- fake SDK phone --------------------------------------------------------

function makePhone() {
  return { registers: 0, unregisters: 0, RegisterDevice() { this.registers++; }, UnRegisterDevice() { this.unregisters++; } };
}

function makeSoftphone() {
  const snaps: any[] = [];
  const sp: any = new Softphone({ accessToken: 't', userId: 'u', onChange: (s: any) => snaps.push(s) });
  const phone = makePhone();
  sp.phone = phone;
  sp.installLifecycle();
  return { sp, phone, snaps };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, fn: () => void) {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e: any) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
}
/** Pretend the tab was hidden for `ms`, then brought back. */
function nap(sp: any, ms: number) {
  doc.hidden = true;
  doc.fire('visibilitychange');
  sp.hiddenSince = Date.now() - ms;
  doc.hidden = false;
  doc.fire('visibilitychange');
}

// --- tests -----------------------------------------------------------------

console.log('\n1. leadership drives registration');
{
  const { sp, phone } = makeSoftphone();
  check('follower does not register', () => assert.equal(phone.registers, 0));
  sp.setLeader(true);
  check('leader registers once', () => assert.equal(phone.registers, 1));
  sp.onRegisterEvent('registered');
  check('snapshot says registered', () => assert.equal(sp.snapshot().registered, true));
  sp.setLeader(false);
  check('demotion unregisters', () => assert.equal(phone.unregisters, 1));
  sp.destroy?.();
  sp.removeLifecycle();
}

console.log('\n2. THE BUG: waking after a long nap re-registers');
{
  const { sp, phone } = makeSoftphone();
  sp.setLeader(true);
  sp.onRegisterEvent('registered');
  check('registered before the nap', () => assert.equal(sp.snapshot().registered, true));

  // The transport dies while frozen. The SDK says nothing, so `registered`
  // stays true — this is exactly the state that made the tab look Ready while
  // being unreachable.
  nap(sp, 5 * 60_000);

  check('cached flag was distrusted', () => assert.equal(sp.snapshot().registered, false));
  check('a fresh REGISTER went out', () => assert.equal(phone.registers, 2));
  sp.onRegisterEvent('registered');
  check('back to ready', () => assert.equal(sp.snapshot().state, 'ready'));
  sp.removeLifecycle();
}

console.log('\n3. a brief tab switch does NOT churn the registration');
{
  const { sp, phone } = makeSoftphone();
  sp.setLeader(true);
  sp.onRegisterEvent('registered');
  nap(sp, 2_000);
  check('no re-register', () => assert.equal(phone.registers, 1));
  check('still shows registered', () => assert.equal(sp.snapshot().registered, true));
  sp.removeLifecycle();
}

console.log('\n4. waking mid-call never touches the registration');
{
  const { sp, phone } = makeSoftphone();
  sp.setLeader(true);
  sp.onRegisterEvent('registered');
  sp.set({ state: 'live', legs: { agent: 'up', customer: 'up' } });
  nap(sp, 10 * 60_000);
  check('no re-register during a call', () => assert.equal(phone.registers, 1));
  check('call state intact', () => assert.equal(sp.snapshot().state, 'live'));
  sp.removeLifecycle();
}

console.log('\n5. re-register is retried, not hammered');
{
  const { sp, phone } = makeSoftphone();
  sp.setLeader(true);
  check('one attempt', () => assert.equal(phone.registers, 1));
  // No `registered` event arrives. Watchdog ticks should respect the cooldown.
  sp.sync(); sp.sync(); sp.sync();
  check('cooldown suppresses repeats', () => assert.equal(phone.registers, 1));
  sp.lastRegisterAt = Date.now() - 10_000;
  sp.sync();
  check('retries once the cooldown lapses', () => assert.equal(phone.registers, 2));
  sp.removeLifecycle();
}

console.log('\n6. a dropped registration is chased immediately');
{
  const { sp, phone } = makeSoftphone();
  sp.setLeader(true);
  sp.onRegisterEvent('registered');
  sp.lastRegisterAt = 0; // cooldown already lapsed
  sp.onRegisterEvent('unregistered'); // transport dropped us
  check('re-registered without waiting for the watchdog', () => assert.equal(phone.registers, 2));
  sp.removeLifecycle();
}

console.log('\n7. demoted mid-flight: the late registration is torn down');
{
  const { sp, phone } = makeSoftphone();
  sp.setLeader(true);
  check('register in flight', () => assert.equal(phone.registers, 1));
  // Demoted before the SIP `registered` event arrives, so `registered` is still
  // false and the naive `if (registered) UnRegisterDevice()` guard misses.
  sp.setLeader(false);
  check('nothing to unregister yet', () => assert.equal(phone.unregisters, 0));
  sp.onRegisterEvent('registered'); // lands late
  check('late arrival is unregistered', () => assert.equal(phone.unregisters, 1));
  check('does not claim to be registered', () => assert.equal(sp.snapshot().registered, false));
  sp.removeLifecycle();
}

console.log('\n8. bfcache restore and network recovery both revalidate');
{
  const { sp, phone } = makeSoftphone();
  sp.setLeader(true);
  sp.onRegisterEvent('registered');
  win.fire('pageshow', { persisted: true });
  check('bfcache restore re-registers', () => assert.equal(phone.registers, 2));
  sp.onRegisterEvent('registered');
  sp.lastRegisterAt = 0;
  win.fire('online');
  check('coming back online re-registers', () => assert.equal(phone.registers, 3));
  sp.removeLifecycle();
}

await tick();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
