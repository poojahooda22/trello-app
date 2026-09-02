import { defineConfig, devices } from "@playwright/test";
import {
  API_URL,
  BACKEND_PORT,
  BASE_URL,
  FRONTEND_PORT,
  INTEGRATION_KEY,
  JWT_SECRET,
  TEST_DATABASE_URL,
  WS_INTERNAL_PORT,
  WS_INTERNAL_TOKEN,
  WS_PORT,
  WS_URL,
} from "./e2e/env";

/**
 * End-to-end tests for the whole product: the Bun frontend, the Express API and
 * the websocket relay, together, against a real Postgres.
 *
 * The suite starts its own copy of all three on dedicated ports (see e2e/env.ts)
 * pointed at the disposable database from docker-compose.test.yml. Bring that up
 * first — `bun run e2e:db:up` — or every spec fails on connection refused.
 *
 * It does NOT reuse the development stack. That one talks to the shared Neon
 * database, and a suite that signs up users and deletes boards must never be one
 * misconfigured variable away from doing it there.
 */

/** Passed to every service so all three agree on the database and the relay token. */
const sharedEnv = {
  DATABASE_URL: TEST_DATABASE_URL,
  WS_INTERNAL_TOKEN,
  NODE_ENV: "test",
};

export default defineConfig({
  testDir: "./e2e/specs",
  // Cards, labels and comments are per-board, and every spec makes its own
  // board, so specs cannot see each other's rows.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // One worker in CI: the suite shares a single Postgres, and the invite and
  // realtime specs are order-sensitive enough that parallel workers on a cold
  // runner are not worth the flake.
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      // The relay first: the backend calls it on WS_INTERNAL_URL as soon as a
      // write lands, and a refused call there is logged as an integration error.
      command: "bun index.ts",
      cwd: "apps/websockets",
      // `port`, not `url`: readiness here is "the socket accepts connections".
      // The relay's only real endpoint is an authenticated POST to
      // /internal/broadcast — every other request is answered 404, which
      // Playwright does not accept as a server being ready.
      port: WS_INTERNAL_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...sharedEnv, WS_PORT: String(WS_PORT), WS_INTERNAL_PORT: String(WS_INTERNAL_PORT) },
    },
    {
      command: "bun index.ts",
      cwd: "apps/backend",
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...sharedEnv,
        PORT: String(BACKEND_PORT),
        JWT_SECRET,
        INTEGRATION_KEY,
        // Also the CORS origin. If it disagrees with baseURL every fetch the
        // app makes is blocked by the browser and the failure looks like a
        // frontend bug.
        APP_URL: BASE_URL,
        WS_INTERNAL_URL: `http://localhost:${WS_INTERNAL_PORT}`,
        // Left unset on purpose: no spec may reach the real GitHub, Slack or
        // Resend. Each feature degrades to a warning, which is what the
        // integration specs assert against.
        GITHUB_APP_ID: "",
        GITHUB_PRIVATE_KEY: "",
        GITHUB_WEBHOOK_SECRET: "e2e-github-webhook-secret",
        RESEND_API_KEY: "",
        INVITE_FROM: "",
      },
    },
    {
      // `bun src/index.ts` rather than the dev script: that one wraps the server
      // in concurrently and a route-generator watcher, neither of which ever
      // exits, so Playwright would never see the process settle.
      command: "bun src/index.ts",
      cwd: "apps/frontend",
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...sharedEnv,
        PORT: String(FRONTEND_PORT),
        // Bun inlines these into the client bundle when it boots, so they must
        // be the E2E ports and must be absolute — the browser resolves them.
        BUN_PUBLIC_API_URL: API_URL,
        BUN_PUBLIC_WS_URL: WS_URL,
      },
    },
  ],
});
