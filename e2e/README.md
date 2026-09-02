# End-to-end tests

Playwright drives a real Chrome against the whole product — the Bun frontend, the Express API and the
websocket relay together, on a real Postgres. Unit tests (`bun test`) cover pure logic; these cover the
parts that only break when the three services meet.

## Running them

```bash
bun run e2e:db:up     # start the throwaway Postgres and migrate it — once per machine boot
bun run e2e           # run the suite; it starts and stops the three services itself
```

Useful variants:

```bash
bun run e2e:ui                       # Playwright's watch-mode UI
bun run e2e -- e2e/specs/auth.spec.ts   # one file
bun run e2e -- --headed --debug      # watch it happen, step through
bun run e2e:report                   # open the HTML report of the last run
bun run e2e:db:reset                 # throw the database away and start clean
bun run e2e:db:down                  # stop the Postgres container
```

## Why it does not reuse your dev stack

`DATABASE_URL` in `apps/backend/.env` points at the **shared Neon database that the live site uses**.
A suite that signs up users, creates boards and deletes cards must never be one misconfigured variable
away from doing that there.

So the suite is isolated twice over:

1. **Its own database** — `docker-compose.test.yml` runs Postgres on `5433`, with its data in `tmpfs`
   so it vanishes when the container stops.
2. **Its own ports** — frontend `5273`, backend `3101`, relay `3102`/`3103` (see `env.ts`). The dev
   stack lives on `5173`/`3001`/`3002`/`3003`. Because `reuseExistingServer` can only ever find a
   server on the E2E ports, a run physically cannot attach to the Neon-backed one.

`smoke.spec.ts` asserts this: it fails if the browser's API calls go anywhere but `:3101`.

Bun auto-loads `apps/backend/.env`, but an explicit value in the environment wins over dotenv — which
is what lets `playwright.config.ts` redirect each service at the test database.

## The fixtures

`fixtures.ts` sets state up over HTTP and drives only the behaviour under test through the browser.
Signing up and building a board by clicking takes about eight seconds and re-tests the same two
screens in every file; the API does it in one round trip.

| Fixture | What you get |
| --- | --- |
| `page` | a Page **already signed in** — the JWT is injected into `localStorage` before the first navigation |
| `user` | `{ id, email, password, token }`, freshly signed up, unique to this test |
| `api` | an `ApiClient` for that user — `createBoard`, `createIssue`, `moveIssue`, `createLabel`, … |
| `org` | an organization owned by `user` |
| `board` | a board titled "Zepto Board" (so keys are `ZEP-1`, `ZEP-2`, …) with the five default columns |
| `teammate` | a **second** user, invited into `org` and already accepted |
| `anon` | an unauthenticated request context, for 401 and validation assertions |

Reach for a column by kind, never by index:

```ts
test("a card lands in To Do", async ({ page, api, board }) => {
  await api.createIssue(board.section("TODO").id, "Write the spec");
  await page.goto(`/boards/${board.id}`);
  await expect(page.getByText("Write the spec")).toBeVisible();
});
```

Every test gets its own user, org and board, so the suite runs `fullyParallel` against one database
without specs seeing each other's rows.

## What the E2E environment deliberately lacks

`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY` and `RESEND_API_KEY` are empty on purpose, so **no spec can
reach a real third party**. Two consequences the specs rely on:

- `POST /invite` returns the invite link in the response body instead of emailing it. That is how the
  `teammate` fixture accepts an invitation.
- GitHub integration reports `canWrite: false`. Integration specs assert on that degraded state rather
  than on a real repository.

`INTEGRATION_KEY` **is** set (64 hex characters), so Slack webhook encryption works and the
integration routes answer instead of returning 503.

## Why the spec files are excluded from `bun test`

Bun's test runner globs `*.spec.ts` as well as `*.test.ts`, so without help it picks these files up
and dies on the first `test()` call — they expect Playwright's runner, not Bun's. The root
`bunfig.toml` excludes `**/e2e/**` from it. That lives in config rather than in the CI command so a
bare local `bun test` is safe too.

## When everything is red at once

Run `smoke.spec.ts` first. It only proves the harness — three services up, the browser pointed at the
E2E backend, fixtures producing a signed-in session on a real board. If it is red, the problem is the
stack or the database, not the feature under test. The usual cause is the Postgres container not
running: `bun run e2e:db:up`.
