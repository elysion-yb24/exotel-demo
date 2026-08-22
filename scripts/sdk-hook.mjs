/**
 * Resolve hook that swaps the Exotel SDK for scripts/sdk-stub.mjs.
 * Preloaded with `node --import ./scripts/sdk-hook.mjs`.
 */
import { registerHooks } from 'node:module';

const STUB = new URL('./sdk-stub.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.includes('exotel-ip-calling-crm-websdk')) {
      return { url: STUB, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
