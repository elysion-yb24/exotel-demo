/* eslint-disable no-undef */
/**
 * Service worker for softphone notifications.
 *
 * READ THIS BEFORE EXPECTING TOO MUCH OF IT.
 *
 * This worker can raise a notification when the tab exists but is not focused
 * — another tab, a minimised window, a different desktop. That is the case it
 * is built for and it works.
 *
 * It CANNOT notify you of an incoming call when the app is closed. Not because
 * of a missing feature here, but because of how the call arrives: the SIP
 * registration lives in the page's WebSocket. Close the page and the device
 * unregisters, so Exotel has nothing to ring and no call event is ever
 * generated. A service worker cannot hold a SIP registration.
 *
 * Notifying a closed app requires Web Push: your backend receives Exotel's
 * inbound webhook and pushes to a stored subscription. The push handler below
 * is wired for that, but the call still will not be answerable in the browser —
 * it can only say "you have a call waiting, open the app". See the README note.
 */

const TAG = 'incoming-call';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ---------------------------------------------------------------------------
// Messages from the page — used for the background-tab case
// ---------------------------------------------------------------------------

self.addEventListener('message', (event) => {
  const msg = event.data || {};

  if (msg.type === 'ringing') {
    event.waitUntil(
      self.registration.showNotification('Incoming call', {
        body: msg.peer ? `From ${msg.peer}` : 'A caller is on the line',
        tag: TAG,
        // renotify so a second call re-alerts instead of silently replacing.
        renotify: true,
        requireInteraction: true,
        silent: false,
        actions: [
          { action: 'accept', title: 'Accept' },
          { action: 'decline', title: 'Decline' },
        ],
        data: { at: Date.now() },
      }),
    );
    return;
  }

  if (msg.type === 'stop-ringing') {
    event.waitUntil(
      self.registration.getNotifications({ tag: TAG }).then((ns) => ns.forEach((n) => n.close())),
    );
  }
});

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  event.notification.close();

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      // If the app is open somewhere, focus it and let the PAGE act. The worker
      // deliberately does not try to accept the call itself — it has no access
      // to the SIP session, and pretending otherwise would drop calls.
      for (const c of clients) {
        if ('focus' in c) {
          await c.focus();
          if (action) c.postMessage({ type: 'notification-action', action });
          return;
        }
      }

      // Nothing open. Opening now cannot answer the ringing call — the SIP
      // device was unregistered when the page closed — so this is only a way
      // back into the app.
      await self.clients.openWindow('/');
    })(),
  );
});

// ---------------------------------------------------------------------------
// Web Push — only fires if you add VAPID keys and a backend push. Inert
// otherwise, which is why it is safe to ship unconfigured.
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Call waiting', {
      body: payload.body || 'Open the softphone to take the call.',
      tag: payload.tag || TAG,
      requireInteraction: true,
      data: payload,
    }),
  );
});
