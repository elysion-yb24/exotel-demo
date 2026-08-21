/**
 * Backend for the softphone.
 *
 * It exists for three reasons, in order of importance:
 *
 * 1. TOKEN MINTING. The app secret must never reach the browser. The browser
 *    gets a short-lived app token scoped to one agent.
 *
 * 2. CUSTOMER LEG TRUTH. Exotel's status callbacks land here, not in the
 *    browser. This is the only place that knows whether the customer answered.
 *    We relay it to the browser over SSE.
 *
 * 3. AUDIT. Every dial gets logged server-side with the agent who placed it.
 *    You cannot audit a browser.
 *
 * A caveat you should know about the CRM SDK: its Initialize() and MakeCall()
 * run in the BROWSER against icore, using the access token directly. So even
 * with this backend in place, the token in the browser can read /app,
 * /app_setting and /usermapping, and can place calls for its user. Keep the TTL
 * short and mint per-agent tokens — never hand out a customer-entity token.
 */

import 'dotenv/config';
import express from 'express';
import type { Response } from 'express';
import type { ServerCallUpdate } from '../types';

const ICORE = 'https://integrationscore.mum1.exotel.com';
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Exotel API helpers
// ---------------------------------------------------------------------------

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};

/** Tokens are short-lived; cache briefly to avoid a mint per page load. */
let appTokenCache: { token: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string> {
  if (appTokenCache && appTokenCache.expiresAt > Date.now()) return appTokenCache.token;

  const res = await fetch(`${ICORE}/v2/integrations/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: env('EXOTEL_APP_ID'), Secret: env('EXOTEL_APP_SECRET'), Entity: 'app' }),
  });
  const body: any = await res.json();
  if (!res.ok || !body?.Data) throw new Error(`Token mint failed (${res.status})`);

  appTokenCache = { token: body.Data, expiresAt: Date.now() + 10 * 60_000 };
  return body.Data;
}

async function icore(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(ICORE + path, {
    ...init,
    headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// SSE fan-out, keyed by agent
// ---------------------------------------------------------------------------

const streams = new Map<string, Set<Response>>();

function pushToAgent(userId: string, update: ServerCallUpdate) {
  const set = streams.get(userId);
  if (!set) return;
  const frame = `data: ${JSON.stringify(update)}\n\n`;
  for (const res of set) res.write(frame);
}

app.get('/api/events/:userId', (req, res) => {
  const { userId } = req.params;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId)!.add(res);

  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    streams.get(userId)?.delete(res);
  });
});

// ---------------------------------------------------------------------------
// Session: mint a token for one agent
// ---------------------------------------------------------------------------

app.post('/api/session', async (req, res) => {
  try {
    // In real life: derive userId from YOUR auth session, never from the body.
    // Trusting a client-supplied userId lets any agent mint a token for any other.
    const userId = String(req.body?.userId ?? env('EXOTEL_TEST_USER_ID'));

    const token = await getAppToken();
    const um = await icore(`/v2/integrations/usermapping?user_id=${encodeURIComponent(userId)}`, token);
    const user = Array.isArray(um.body?.Data) ? um.body.Data[0] : um.body?.Data;

    if (!user?.SipId) {
      return res.status(409).json({
        error: 'not_voip_provisioned',
        message:
          'This agent has no SIP credentials. The account is not VoIP-enabled — ' +
          'contact your Exotel account manager. Client code cannot work around this.',
      });
    }

    res.json({
      accessToken: token,
      userId,
      displayName: user.AppUsername ?? userId,
      sipId: user.SipId,
      callerId: user.VirtualNumber ?? null,
      activeDevice: user.ActiveDeviceId === user.PhoneDeviceID ? 'phone' : 'sip',
    });
  } catch (e: any) {
    res.status(500).json({ error: 'session_failed', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Device toggle: SIP (browser) vs phone (agent's mobile)
// ---------------------------------------------------------------------------

app.put('/api/device', async (req, res) => {
  try {
    const { userId, device, on } = req.body as {
      userId: string;
      device: 'sip' | 'phone';
      on: boolean;
    };
    const token = await getAppToken();
    const out = await icore('/v2/integrations/device', token, {
      method: 'PUT',
      body: JSON.stringify({ UserId: userId, DeviceName: device, DeviceStatus: on }),
    });
    res.status(out.ok ? 200 : out.status).json(out.body);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Optional server-side dial
// ---------------------------------------------------------------------------

/**
 * The CRM SDK dials from the browser. This route does the same thing from the
 * server, which is what you want if you need the dial to be auditable or
 * policy-checked (do-not-call lists, consent, working hours) before it happens.
 * Client-side dialling cannot be enforced.
 */
app.post('/api/dial', async (req, res) => {
  try {
    const { userId, to } = req.body as { userId: string; to: string };
    const token = await getAppToken();

    // Hook your compliance checks in here, before the call is placed.
    console.log(`[audit] ${new Date().toISOString()} agent=${userId} dial=${to}`);

    const out = await icore('/v2/integrations/call/outbound_call', token, {
      method: 'POST',
      body: JSON.stringify({
        customer_id: env('EXOTEL_CUSTOMER_ID'),
        app_id: env('EXOTEL_APP_ID'),
        to,
        user_id: userId,
      }),
    });
    res.status(out.ok ? 200 : out.status).json(out.body);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Status callbacks — the only source of customer leg truth
// ---------------------------------------------------------------------------

/**
 * Register this URL as the `callback` key via POST /v2/integrations/app_setting.
 *
 * Exotel sends CallState "active" | "terminal". "active" means the call is live
 * or still being processed; "terminal" means it is over and billed. Neither maps
 * cleanly to "customer picked up", so we infer from duration and status.
 */
app.post('/webhooks/exotel/call', (req, res) => {
  const b = req.body ?? {};
  const userId = String(b.AppUserID ?? '');

  const answered = Number(b.TotalDuration ?? 0) > 0 || /answer|complete|in-progress/i.test(String(b.CallStatus ?? ''));
  const terminal = String(b.CallState ?? '').toLowerCase() === 'terminal';

  const update: ServerCallUpdate = {
    callSid: String(b.CallSid ?? ''),
    direction: /out/i.test(String(b.Direction ?? '')) ? 'outbound' : 'inbound',
    callState: terminal ? 'terminal' : 'active',
    customerLeg: terminal ? 'down' : answered ? 'up' : 'ringing',
    toNumber: b.ToNumber,
    fromNumber: b.FromNumber,
    totalDuration: Number(b.TotalDuration ?? 0),
    recordingUrl: b.CallRecordings || undefined,
  };

  console.log('[webhook]', update.callSid, update.direction, update.callState, update.customerLeg);
  if (userId) pushToAgent(userId, update);

  // Always 200 quickly. Slow or failing webhook handlers get retried, and you
  // will process duplicates — make this idempotent on CallSid.
  res.sendStatus(200);
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`softphone backend on http://localhost:${port}`);
  console.log(`expose /webhooks/exotel/call publicly (ngrok) and set it as the "callback" app_setting`);
});
