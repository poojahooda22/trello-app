/**
 * Runs before any test file (bunfig.toml → [test] preload). secrets.ts reads
 * INTEGRATION_KEY once, when the module is first evaluated, and the webhook
 * tests import integrations.ts, which imports secrets.ts — so whichever file
 * Bun loads first decides whether the key is there. Setting it here, ahead of
 * every import, is what makes the suite order-independent. CI has no .env,
 * so this is also the only source of the key there.
 */
process.env.INTEGRATION_KEY ??= "0".repeat(63) + "1";
