/**
 * Desktop notifications for the background-tab case.
 *
 * Scope, stated plainly so nobody builds on a wrong assumption: this notifies
 * when the app is OPEN BUT NOT FOCUSED. It cannot notify when the app is
 * closed, because closing the page unregisters the SIP device and Exotel never
 * rings it — there is no call event to notify about. See public/sw.js.
 */

export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

export class Notifier {
  private reg: ServiceWorkerRegistration | null = null;
  private onAction: ((action: string) => void) | null = null;

  get state(): NotifyState {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'unsupported';
    return Notification.permission as NotifyState;
  }

  /**
   * Register the worker. Safe to call on mount — registration does not itself
   * prompt for permission.
   */
  async register(onAction?: (action: string) => void): Promise<void> {
    if (!('serviceWorker' in navigator)) return;
    this.onAction = onAction ?? null;

    try {
      this.reg = await navigator.serviceWorker.register('/sw.js');
    } catch {
      // A failed registration must not take the softphone down with it.
      this.reg = null;
      return;
    }

    navigator.serviceWorker.addEventListener('message', this.handleMessage);
  }

  /** Must be called from a user gesture, or browsers will auto-deny. */
  async requestPermission(): Promise<NotifyState> {
    if (this.state === 'unsupported') return 'unsupported';
    try {
      return (await Notification.requestPermission()) as NotifyState;
    } catch {
      return this.state;
    }
  }

  /**
   * Raise the incoming-call notification — but only when the page is hidden.
   * Notifying someone about a dialog they are already looking at is noise.
   */
  ringing(peer: string): void {
    if (this.state !== 'granted') return;
    if (!document.hidden) return;
    this.post({ type: 'ringing', peer });
  }

  stopRinging(): void {
    this.post({ type: 'stop-ringing' });
  }

  dispose(): void {
    navigator.serviceWorker?.removeEventListener('message', this.handleMessage);
    this.onAction = null;
  }

  private post(msg: unknown): void {
    const target = this.reg?.active ?? navigator.serviceWorker?.controller;
    target?.postMessage(msg);
  }

  private handleMessage = (event: MessageEvent) => {
    const data = event.data || {};
    if (data.type === 'notification-action' && data.action) this.onAction?.(data.action);
  };
}
