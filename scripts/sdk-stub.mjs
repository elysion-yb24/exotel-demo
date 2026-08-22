/**
 * Stands in for the Exotel CRM SDK under Node.
 *
 * The real package is bundler-only: it reaches for `document` and `require`s a
 * .wav at import time, so merely importing softphone.ts outside Vite throws.
 * The registration tests never call connect(), so a shell is enough.
 */
export default class ExotelCRMWebSDK {
  async Initialize() {
    return null;
  }
}
