# Exotel VoIP softphone prototype

A working TypeScript skeleton for browser-based agent calling on Exotel, built
against the **real npm packages** (not a mock). Typechecks clean.

```
npm install
cp .env.example .env      # fill in both credential sets
npm run smoke             # validate provisioning BEFORE writing any UI
npm run server            # terminal 1 — backend on :8787
npm run dev               # terminal 2 — softphone on :5173
```

---

## Corrections to Exotel's published docs

Found by installing and reading the shipped `.d.ts` files. Trust this list over
the docs and the GitHub README, both of which are stale.

| Exotel says | Actually |
|---|---|
| `@exotel/webrtc-client-sdk` | **`@exotel-npm-dev/webrtc-client-sdk`**. The `@exotel` scope 404s. |
| "Contact us for credentials to download the package" | All three packages are **public on npm**. No gating: `exotel-ip-calling-crm-websdk@1.2.2`, `webrtc-client-sdk@3.0.11`, `webrtc-core-sdk`. |
| `MakeCall(Number, dialCallback, CustomField)` | **`MakeCall(number, callback)`** — two args. `CustomField` is not in the v1.2.2 types. Correlate on `CallSid` in your webhook instead. |
| Outbound goes via `/v1/Accounts/{sid}/Calls/connect` | The CRM SDK posts to **`POST {icore}/v2/integrations/call/outbound_call`** with `{customer_id, app_id, to, user_id}`. The v1 Connect API is only for hand-rolling against the low-level SDK. |
| Call events include `callended`, `terminated` | Events are **`incoming` \| `connected` \| `callEnded` \| `holdtoggle` \| `mutetoggle`**. Note the camelCase `callEnded`. No `terminated` at this layer. |
| "There is no callback event for mute / hold" | True of the low-level SDK; the **CRM layer does emit** `mutetoggle` and `holdtoggle`. |
| README omits DTMF on the phone object | **`SendDTMF(digit)` exists.** |

Two more things worth knowing before you commit:

**The package is Mumbai-only.** `Constants.js` hardcodes
`integrationscore.mum1.exotel.com`, `voip.in1.exotel.com:443` and
`voip.exotel.com`. A Singapore-region account cannot use this package unpatched
— you'd drop to the low-level SDK and supply your own SIP domain. The smoke test
warns if your app's `ExotelDomain` looks like Singapore.

**Treat the SIP secret as public.** `User.js` AES-decrypts `SipSecret` using a
key exported from `Constants.js` in the published package. That's obfuscation,
not encryption. Combined with `Initialize()` fetching `/app`, `/app_setting` and
`/usermapping` **from the browser** using the access token, assume anything the
token can reach is visible to the agent. Mint short-lived, per-agent, app-entity
tokens; never ship a customer-entity token to a browser.

**Type declaration quirk:** `Initialize()` types its optional callbacks as
`null`, not as function types, so passing real handlers needs an `as any` cast.
See the cast in `src/client/softphone.ts` — it's the SDK's bug, not yours.

---

## The flow

```
  ┌─ browser ──────────────────┐        ┌─ your backend ─────────┐
  │ ExotelCRMWebSDK            │        │ mints app token        │
  │  └ ExotelWebPhoneSDK       │◀──────▶│ receives status        │
  │      SIP/WSS registration  │  SSE   │   callbacks            │
  └────────┬───────────────────┘        └───────────┬────────────┘
           │                                        │
           │  ①  MakeCall() ─── POST ──▶ icore /call/outbound_call
           │                                        │
           │  ②  Exotel rings THIS BROWSER          │
           │      → arrives as `incoming` event     │
           │                                        │
           │  ③  auto-answer → `connected`          │
           │      agent leg UP, customer NOT reached│
           │                                        │
           │  ④  Exotel dials customer over PSTN    │
           │                                        │
           │  ⑤  customer answers ──── webhook ────▶│
           │      ◀──────── SSE ────────────────────┘
           │      customer leg UP → truly live
```

### The bug this prototype exists to prevent

`MakeCall()` does not open a call. It queues a request and returns. Exotel then
rings *the agent's own browser*, and the SDK reports that as `incoming`.

If you render every `incoming` as "Call from X — Accept / Reject", then clicking
**Call** in your CRM makes your app ask the agent whether they'd like to accept
the call they just placed.

The fix is correlation (`src/client/softphone.ts`): set a `pendingOutbound` flag
**before** the fetch, adopt the next `incoming` leg that arrives inside the
window as yours, and auto-answer it. Arming before the request matters — the leg
can arrive faster than the fetch resolves.

### The lie this prototype refuses to tell

`connected` means *the agent's browser is connected to Exotel*. Nothing more.
For an outbound call the customer's phone hasn't even rung yet. The browser is
not party to the customer leg and cannot observe it.

So the UI models two legs independently. The agent leg comes from SDK events;
the customer leg comes **only** from status callbacks hitting your backend and
relayed over SSE. That's why `applyServerUpdate()` exists, and why the UI shows
`dialing_customer` — agent up, customer still ringing — as a distinct state.

---

## Files

| File | What it's for |
|---|---|
| `scripts/smoke-test.ts` | Walks token → app → SIP provisioning → WSS reachability → real dial. Stops at the first failure with a fix. **Run this first.** |
| `src/types.ts` | The leg model and state machine types. |
| `src/client/softphone.ts` | The core. State machine, outbound correlation, timeout handling, error translation. |
| `src/client/tabLeader.ts` | BroadcastChannel leader election. Exotel's docs make this your job: every open tab registers and rings otherwise. |
| `src/server/server.ts` | Token minting, status-callback webhook, SSE fan-out, optional server-side dial for auditable/compliance-gated calling. |
| `src/ui/Softphone.tsx` | Agent UI. The signal path is the centrepiece: browser ─ Exotel ─ customer, per-leg state. |

## Wiring the webhook

The customer leg stays unknown until this is connected:

```bash
ngrok http 8787
```

Then register the public URL as the `callback` app setting:

```bash
curl -X POST https://integrationscore.mum1.exotel.com/v2/integrations/app_setting \
  -H "Authorization: $APP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"Key":"callback","Value":"https://<id>.ngrok.app/webhooks/exotel/call"}'
```

Callbacks retry, so make the handler idempotent on `CallSid`.

## If the smoke test fails at step 3

Empty `SipId` / `SipSecret` means the account isn't VoIP-provisioned, and no
client code will fix it. IP-PSTN calling lives on a separate account under the
Veeno Communications entity (Exotel's UL-VNO licence holder) on an Unlimited
Calling Plan. Steps 1–2 passing while step 3 returns an empty `SipId` is the
signature of a standard trial account: Connect API works, WebRTC doesn't.

## Not built yet

Deliberate gaps, roughly in the order I'd add them:

- Token refresh. Tokens expire mid-shift; the client has no renewal path.
- Device diagnostics. The low-level SDK has mic/speaker/ICE tests worth surfacing
  before a shift rather than mid-call.
- Reconnect on websocket drop, with the `shouldAutoRetry` pattern from the docs.
- Call disposition / wrap-up, and joining `CallSid` to your CRM records.
- Recording retrieval from the terminal status callback.
