/**
 * Exotel VoIP smoke test.
 *
 * Run this FIRST, before writing any UI:
 *
 *   cp .env.example .env   # fill it in
 *   npm install
 *   npm run smoke
 *
 * It walks the provisioning chain in dependency order and stops at the first
 * failure, so you learn which link is missing rather than debugging a silent
 * softphone. Step 5 places a real call and costs real money.
 */

import 'dotenv/config';

const ICORE = 'https://integrationscore.mum1.exotel.com';

// ---------------------------------------------------------------------------
// Tiny reporter
// ---------------------------------------------------------------------------

let step = 0;
const pass = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const info = (m: string) => console.log(`    \x1b[90m${m}\x1b[0m`);
const head = (m: string) => console.log(`\n\x1b[1m${++step}. ${m}\x1b[0m`);

class Stop extends Error {
  constructor(public reason: string, public fix: string) {
    super(reason);
  }
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Stop(`${name} is not set`, `Add ${name} to your .env`);
  return v;
}

async function icore(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(ICORE + path, {
    ...init,
    headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Exchange an id/secret pair for a bearer token. */
async function getToken(id: string, secret: string, entity: 'customer' | 'app') {
  const res = await fetch(`${ICORE}/v2/integrations/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: id, Secret: secret, Entity: entity }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.Data) {
    throw new Stop(
      `${entity} token request returned ${res.status}`,
      res.status === 401
        ? `Check EXOTEL_${entity.toUpperCase()}_ID / _SECRET — 401 means the pair is wrong, not that the account lacks VoIP.`
        : `Unexpected response: ${JSON.stringify(body)?.slice(0, 200)}`,
    );
  }
  return body.Data as string;
}

async function main() {
  console.log('\n\x1b[1mExotel VoIP smoke test\x1b[0m');
  info('Reads .env. Steps 1-4 are read-only. Step 5 places a real call.');

  // -- 1 -------------------------------------------------------------------
  head('Customer token');
  const customerToken = await getToken(
    need('EXOTEL_CUSTOMER_ID'),
    need('EXOTEL_CUSTOMER_SECRET'),
    'customer',
  );
  pass('customer credentials accepted');

  // -- 2 -------------------------------------------------------------------
  head('App token and registration');
  const appToken = await getToken(need('EXOTEL_APP_ID'), need('EXOTEL_APP_SECRET'), 'app');
  pass('app credentials accepted');

  const app = await icore('/v2/integrations/app?entity=app', appToken);
  if (!app.ok) {
    throw new Stop(
      `GET /app returned ${app.status}`,
      'The app token works but the app record is unreadable. Ask Exotel to confirm the app exists.',
    );
  }
  const appData = app.body?.Data ?? {};
  pass(`app "${appData.AppName ?? '(unnamed)'}" found`);
  info(`ExotelAccountSid: ${appData.ExotelAccountSid ?? '(none)'}`);
  info(`ExotelDomain:     ${appData.ExotelDomain ?? '(none)'}`);

  if (appData.IsActive === false) {
    throw new Stop(
      'App exists but IsActive is false',
      'An inactive app will register SIP fine and refuse to place calls. Re-register it with IsActive: true.',
    );
  }
  pass('app is active');

  // The npm package hardcodes the Mumbai icore host and voip.in1.exotel.com.
  // A Singapore-domain app cannot use it unpatched.
  if (typeof appData.ExotelDomain === 'string' && /sing/i.test(appData.ExotelDomain)) {
    info('\x1b[33mWARNING\x1b[0m: app domain looks like Singapore.');
    info('The CRM SDK hardcodes the Mumbai icore host and voip.in1.exotel.com.');
    info('You will need the low-level SDK with your own SIP domain instead.');
  }

  // -- 3 -------------------------------------------------------------------
  head('Agent SIP provisioning');
  const userId = need('EXOTEL_TEST_USER_ID');
  const um = await icore(`/v2/integrations/usermapping?user_id=${encodeURIComponent(userId)}`, appToken);
  if (!um.ok) {
    throw new Stop(
      `GET /usermapping returned ${um.status}`,
      `No mapping for AppUserId "${userId}". Register the user via POST /v2/integrations/usermapping first.`,
    );
  }
  const user = Array.isArray(um.body?.Data) ? um.body.Data[0] : um.body?.Data;
  if (!user) throw new Stop('User mapping came back empty', `Register AppUserId "${userId}".`);

  pass(`user "${user.AppUsername ?? userId}" found`);
  info(`SipId:         ${user.SipId || '(EMPTY)'}`);
  info(`SipSecret:     ${user.SipSecret ? '(present)' : '(EMPTY)'}`);
  info(`VirtualNumber: ${user.VirtualNumber || '(EMPTY)'}`);
  info(`ActiveDevice:  ${user.ActiveDeviceId || '(none set)'}`);

  // THIS is the check that tells you whether the account is VoIP-enabled.
  if (!user.SipId || !user.SipSecret) {
    throw new Stop(
      'User has no SIP credentials',
      [
        'This is the signature of a non-VoIP account, and no amount of client code will fix it.',
        'IP-PSTN calling is provisioned under the Veeno Communications entity on a separate',
        'account with an Unlimited Calling Plan. Your integration code is probably fine —',
        'ask your account manager to enable VoIP and re-issue credentials.',
      ].join('\n      '),
    );
  }
  pass('SIP credentials provisioned — this account is VoIP-enabled');

  if (!user.VirtualNumber) {
    info('\x1b[33mWARNING\x1b[0m: no VirtualNumber. Outbound calls need a caller ID.');
  }

  // -- 4 -------------------------------------------------------------------
  head('Voice WebSocket reachability');
  // The browser reaches SIP over WSS on 443. A TLS handshake from Node is a
  // decent proxy for "is this host reachable from my network at all".
  const voipHost = 'voip.in1.exotel.com';
  try {
    const tls = await import('node:tls');
    await new Promise<void>((resolve, reject) => {
      const sock = tls.connect({ host: voipHost, port: 443, servername: voipHost }, () => {
        sock.end();
        resolve();
      });
      sock.setTimeout(6000, () => {
        sock.destroy();
        reject(new Error('timeout'));
      });
      sock.on('error', reject);
    });
    pass(`TLS to ${voipHost}:443 succeeded`);
    info('Browsers still need wss:// allowed by proxy/firewall — this only proves the host is reachable.');
  } catch (e: any) {
    throw new Stop(
      `Cannot reach ${voipHost}:443 (${e.message})`,
      'Whitelist Exotel voice hosts and 443 outbound. On a corporate network this is usually the blocker.',
    );
  }

  // -- 5 -------------------------------------------------------------------
  head('Place a real outbound call');
  const to = process.env.SMOKE_TEST_DIAL_TO;
  if (!to) {
    info('SMOKE_TEST_DIAL_TO is not set — skipping.');
    info('Set it to a phone you can answer to test end to end.');
  } else {
    info(`Dialling ${to} as user ${userId}. Your SIP endpoint must be REGISTERED to hear it.`);
    const dial = await icore('/v2/integrations/call/outbound_call', appToken, {
      method: 'POST',
      body: JSON.stringify({
        customer_id: need('EXOTEL_CUSTOMER_ID'),
        app_id: need('EXOTEL_APP_ID'),
        to,
        user_id: userId,
      }),
    });
    if (!dial.ok) {
      throw new Stop(
        `outbound_call returned ${dial.status}: ${JSON.stringify(dial.body)?.slice(0, 300)}`,
        'Common causes: agent device is off, agent marked busy, caller ID not owned by the account, or no active calling plan.',
      );
    }
    pass('call request accepted');
    info(JSON.stringify(dial.body?.Data ?? dial.body).slice(0, 300));
    info('');
    info('Expected sequence: your SIP endpoint rings FIRST (agent leg),');
    info(`then ${to} rings once you answer. If the agent leg never rings,`);
    info('the SIP device is off or unregistered — not a dialling problem.');
  }

  console.log('\n\x1b[32m\x1b[1mAll checks passed.\x1b[0m Provisioning is sound; build the client.\n');
}

main().catch((e) => {
  if (e instanceof Stop) {
    console.log(`\n  \x1b[31m✗ ${e.reason}\x1b[0m`);
    console.log(`\n    \x1b[1mFix:\x1b[0m ${e.fix}\n`);
  } else {
    console.log(`\n  \x1b[31m✗ Unexpected: ${e?.message ?? e}\x1b[0m\n`);
  }
  process.exit(1);
});
