/**
 * Standalone SIP-over-WSS REGISTER probe. No browser, no icore, no CRM SDK.
 *
 * Answers one question: do the dashboard VoIP credentials actually register
 * against Exotel's SIP edge? If this returns 200 OK, the low-level
 * webrtc-client-sdk path is viable and the customer_id/app_id chain is
 * unnecessary for registration.
 *
 * Values mirror what sipjsphone.js loadCredentials() builds from the CRM SDK
 * config, so a pass here predicts a pass in the browser.
 *
 *   node sip-probe.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l && !l.trimStart().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const SIP_ID = (env.EXOTEL_SIP_ID || '').replace(/^sip:/, '');
const SECRET = env.EXOTEL_SIP_SECRET || '';
const ACCOUNT = env.EXOTEL_ACCOUNT_SID || '';

if (!SIP_ID || !SECRET) {
  console.error('Need EXOTEL_SIP_ID and EXOTEL_SIP_SECRET in .env');
  process.exit(2);
}

// Derived exactly as the shipped SDK derives them.
const WS_URL = 'wss://voip.in1.exotel.com:443/wss';
const SIP_DOMAIN = `${ACCOUNT}.voip.exotel.com`;
const REALM_HINT = 'voip.in1.exotel.com';
const AOR = `sip:${SIP_ID}@${SIP_DOMAIN}`;

const md5 = (s) => createHash('md5').update(s).digest('hex');
const rand = (n = 12) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

const callId = rand(16);
const fromTag = rand(8);
let cseq = 0;

function register(authHeader) {
  cseq += 1;
  const lines = [
    `REGISTER sip:${SIP_DOMAIN} SIP/2.0`,
    `Via: SIP/2.0/WSS ${rand(10)}.invalid;branch=z9hG4bK${rand(10)}`,
    'Max-Forwards: 70',
    `To: <${AOR}>`,
    `From: <${AOR}>;tag=${fromTag}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} REGISTER`,
    `Contact: <sip:${rand(8)}@${rand(10)}.invalid;transport=ws>;expires=600`,
    'Allow: ACK,CANCEL,INVITE,MESSAGE,BYE,OPTIONS,INFO,NOTIFY,REFER',
    'Supported: path,gruu,outbound',
    'User-Agent: exotel-sip-probe',
  ];
  if (authHeader) lines.push(`Authorization: ${authHeader}`);
  lines.push('Content-Length: 0', '', '');
  return lines.join('\r\n');
}

function parseChallenge(msg) {
  const m = msg.match(/^(?:WWW-Authenticate|Proxy-Authenticate):\s*Digest\s*(.*)$/im);
  if (!m) return null;
  const p = {};
  for (const kv of m[1].matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) p[kv[1]] = kv[2] ?? kv[3];
  return p;
}

function buildAuth(c) {
  const uri = `sip:${SIP_DOMAIN}`;
  const realm = c.realm || REALM_HINT;
  const ha1 = md5(`${SIP_ID}:${realm}:${SECRET}`);
  const ha2 = md5(`REGISTER:${uri}`);
  const parts = [`username="${SIP_ID}"`, `realm="${realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`];
  let response;
  if (c.qop) {
    const cnonce = rand(16);
    const nc = '00000001';
    response = md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:auth:${ha2}`);
    parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    response = md5(`${ha1}:${c.nonce}:${ha2}`);
  }
  parts.push(`response="${response}"`, `algorithm=${c.algorithm || 'MD5'}`);
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

console.log(`transport : ${WS_URL}`);
console.log(`identity  : ${AOR}`);
console.log(`--`);

const ws = new WebSocket(WS_URL, ['sip']);
let challenged = false;
const timer = setTimeout(() => {
  console.log('\nTIMEOUT — no final response in 20s');
  process.exit(1);
}, 20000);

ws.onopen = () => {
  console.log('ws open, subprotocol =', JSON.stringify(ws.protocol));
  ws.send(register(null));
};

ws.onmessage = async (ev) => {
  const msg = typeof ev.data === 'string' ? ev.data : await ev.data.text();
  const status = (msg.match(/^SIP\/2\.0 (\d{3})(.*)$/m) || [])[0]?.trim();
  if (!status) return;
  console.log('<<', status);

  if (/^SIP\/2\.0 40[17]/.test(msg) && !challenged) {
    challenged = true;
    const c = parseChallenge(msg);
    if (!c) {
      console.log('could not parse digest challenge');
      return process.exit(1);
    }
    console.log(`   realm="${c.realm}" qop=${c.qop || '(none)'}`);
    ws.send(register(buildAuth(c)));
    return;
  }

  if (/^SIP\/2\.0 2\d\d/.test(msg)) {
    clearTimeout(timer);
    console.log('\nREGISTERED — VoIP credentials are valid and the SIP edge accepted them.');
    console.log('The low-level SDK path works. No customer_id/app_id needed to register.');
    process.exit(0);
  }
  if (/^SIP\/2\.0 [45]\d\d/.test(msg) && challenged) {
    clearTimeout(timer);
    console.log('\nREJECTED after auth. 403/404 usually means the SIP user exists but');
    console.log('VoIP is not entitled on the account; 401 again means wrong password.');
    process.exit(1);
  }
};

ws.onerror = (e) => {
  clearTimeout(timer);
  console.log('ws error:', e.message || e.type);
  process.exit(1);
};
