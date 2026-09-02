/**
 * The E2E stack's addresses, in one place.
 *
 * These are deliberately NOT the development ports (5173/3001/3002/3003). The
 * developer stack points at the shared Neon database; this one points at the
 * throwaway Postgres from docker-compose.test.yml. Giving the suite its own
 * ports means a spec run cannot attach to the Neon-backed stack even if it is
 * already running — `reuseExistingServer` can only ever find a server that
 * this file started.
 */

export const FRONTEND_PORT = 5273;
export const BACKEND_PORT = 3101;
export const WS_PORT = 3102;
export const WS_INTERNAL_PORT = 3103;

export const BASE_URL = `http://localhost:${FRONTEND_PORT}`;
export const API_URL = `http://localhost:${BACKEND_PORT}`;
export const WS_URL = `ws://localhost:${WS_PORT}`;

/**
 * The disposable Postgres. Published on 5433 by docker-compose.test.yml, so it
 * never collides with a Postgres on the default port.
 *
 * Bun auto-loads apps/backend/.env, which carries the Neon URL — but an
 * explicit value in the environment wins over dotenv, which is what lets the
 * webServer entries below redirect each service at this database instead.
 */
export const TEST_DATABASE_URL = "postgresql://trello:trello@localhost:5433/trello_test";

/** Test-only secrets. Real ones never appear here; these exist so the stack boots. */
export const JWT_SECRET = "e2e-jwt-secret-not-used-anywhere-else";
export const WS_INTERNAL_TOKEN = "e2e-ws-internal-token";
/** Exactly 64 hex characters, or secrets.ts disables encryption and integration routes 503. */
export const INTEGRATION_KEY = "0".repeat(63) + "1";
