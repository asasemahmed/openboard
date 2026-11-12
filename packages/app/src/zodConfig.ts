/**
 * Imported before anything else. Zod (through @openboard/core) probes whether
 * it may compile validators with `new Function`; under this app's
 * Content-Security-Policy the probe fails quietly but is still reported as a
 * violation. Telling it up front not to try keeps the console clean.
 */
const holder = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
holder.__zod_globalConfig = { ...holder.__zod_globalConfig, jitless: true };

export {};
