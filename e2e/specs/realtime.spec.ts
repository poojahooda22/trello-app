import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

import { BASE_URL, WS_INTERNAL_PORT, WS_INTERNAL_TOKEN, WS_URL } from "../env";
import { authenticate, expect, test, type TestUser } from "../fixtures";

/**
 * Realtime, in two genuine browsers.
 *
 * The relay holds no board data. The backend owns every write and POSTs
 * /internal/broadcast to fan it out (apps/backend/realtime.ts), and a join is
 * only accepted with a room token the backend minted into the getSections
 * response (apps/websockets/index.ts). So the thing worth asserting is never
 * "the writer's own tab updated" — that is the mutation's onSuccess — but what
 * the OTHER person sees, and how soon.
 *
 * Every tab here is its own browser context. Two pages in one context share a
 * localStorage, and the token lives in localStorage: a second page would be the
 * same person, which is the one thing these specs must not be.
 */

const WS_INTERNAL_URL = `http://localhost:${WS_INTERNAL_PORT}`;

// Two page loads, two websockets and a teammate invite land in every test in
// this file, so the suite-wide 30s budget is tight before the board is even up.
test.beforeEach(() => {
  test.setTimeout(60_000);
});

/**
 * Playwright only cleans up the contexts IT made — the ones behind the `context`
 * and `page` fixtures (playwright/lib/index.js, `_contextFactory`). A context
 * built here by hand is closed by nobody, and `browser` is worker-scoped, so a
 * test that fails before its own close() leaves a live tab reconnecting its
 * socket for the rest of the worker — on CI, across both retries. Hence the
 * register-and-drain below; closing twice is a no-op (BrowserContext.close
 * returns early once isClosed()), so the deliberate close in the presence test
 * still reads as the leave signal it is.
 */
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

/** A second person's browser: its own storage, its own socket, its own presence. */
async function openTab(browser: Browser, as: TestUser) {
  // baseURL is a property of the `page`/`context` fixtures, not of the browser:
  // it is threaded through _combinedContextOptions, which browser.newContext()
  // never sees. Without it every goto("/boards/…") below is a relative URL
  // against about:blank and the navigation fails outright.
  const context = await browser.newContext({ baseURL: BASE_URL });
  opened.push(context);
  const page = await context.newPage();
  await authenticate(page, as.token);
  return { context, page };
}

/**
 * A column, found by the heading it renders rather than by its place on the
 * board — BoardColumn draws a plain <section> with an <h2> inside and no
 * accessible name of its own, so this is the narrowest handle the markup gives.
 * Scoping matters here: "the card is visible" is true from the moment it is
 * created; "the card is in Done" is the assertion realtime can actually fail.
 */
function column(page: Page, name: string) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

/** Every frame the relay pushed to this tab, in arrival order. Register before the first goto. */
function relayFrames(page: Page): string[] {
  const frames: string[] = [];
  page.on("websocket", (ws) => {
    // The frontend dev server has a socket of its own; only the relay's counts.
    if (!ws.url().startsWith(WS_URL)) return;
    ws.on("framereceived", ({ payload }) => {
      frames.push(typeof payload === "string" ? payload : payload.toString("utf8"));
    });
  });
  return frames;
}

/**
 * Pushes a frame into the relay exactly as the backend's publish() does. Used
 * to replay a stale snapshot no real write would ever produce — the point is
 * the client's version guard, and the backend cannot be made to emit a
 * regression on purpose.
 *
 * `delivered` is the relay's own count of sockets it wrote to, which doubles as
 * proof that the tab under test was in the room when the frame went out.
 */
async function broadcast(anon: APIRequestContext, boardId: string, event: unknown) {
  const res = await anon.post(`${WS_INTERNAL_URL}/internal/broadcast`, {
    headers: { Authorization: `Bearer ${WS_INTERNAL_TOKEN}`, "Content-Type": "application/json" },
    data: { boardId, event },
  });
  if (!res.ok()) throw new Error(`internal broadcast failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as { ok: boolean; delivered: number };
}

test("a card added in one tab appears in the other, over the socket rather than a refetch", async ({
  browser,
  user,
  teammate,
  board,
}) => {
  const mine = await openTab(browser, user);
  const theirs = await openTab(browser, teammate.user);
  await mine.page.goto(`/boards/${board.id}`);
  await theirs.page.goto(`/boards/${board.id}`);

  // Both sockets have to be in the room before the write, or the event is
  // simply missed — nothing replays it. Presence is the app's own report that
  // the join was accepted, so it is the gate rather than a sleep.
  await expect(mine.page.getByText("1 other here", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(theirs.page.getByText("1 other here", { exact: true })).toBeVisible({ timeout: 15_000 });

  // Counted only from here: the loads above legitimately fetch /sections, and a
  // focus change while the second context opened may legitimately refetch it.
  let refetches = 0;
  theirs.page.on("request", (req) => {
    if (req.url().includes("/sections?")) refetches += 1;
  });

  const todo = column(mine.page, "To Do");
  await todo.getByRole("button", { name: "Add a card" }).click();
  await todo.getByPlaceholder("Enter a title").fill("Card from the first tab");
  await todo.getByRole("button", { name: "Add issue" }).click();

  await expect(todo.getByText("Card from the first tab")).toBeVisible();

  // The other person never touched their keyboard.
  await expect(column(theirs.page, "To Do").getByText("Card from the first tab")).toBeVisible({ timeout: 15_000 });
  // Board title "Zepto Board" -> keyPrefix ZEP, and this is the board's first
  // card: the key travelled with the event, it was not invented client-side.
  await expect(column(theirs.page, "To Do").getByText("ZEP-1", { exact: true })).toBeVisible();

  // The card is in the second tab and /sections was never asked again — the
  // socket patched the cache. Without this, "appears in the other tab" would
  // also pass on a background refetch, which is the behaviour we replaced.
  expect(refetches).toBe(0);

  await theirs.context.close();
  await mine.context.close();
});

test("a move a teammate makes lands in both tabs' new column live", async ({
  browser,
  user,
  teammate,
  api,
  board,
}) => {
  const card = await api.createIssue(board.section("TODO").id, "Card that will move");

  const mine = await openTab(browser, user);
  const theirs = await openTab(browser, teammate.user);
  await mine.page.goto(`/boards/${board.id}`);
  await theirs.page.goto(`/boards/${board.id}`);

  await expect(mine.page.getByText("1 other here", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(theirs.page.getByText("1 other here", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(column(mine.page, "To Do").getByText("Card that will move")).toBeVisible();

  // Moved over the API rather than dragged: the drag is dnd-kit's contract and
  // belongs to a drag spec. What is under test is the fan-out, and PUT
  // /issue/move is the same code path a drop ends in — moveIssueTo publishes
  // issue_moved once the guarded write lands.
  const moved = await teammate.api.moveIssue(card.id, board.section("INPROGRESS").id);
  expect(moved.ok()).toBe(true);

  // Neither tab issued the write, so both learn about it the same way.
  await expect(column(mine.page, "In Progress").getByText("Card that will move")).toBeVisible({ timeout: 15_000 });
  await expect(column(theirs.page, "In Progress").getByText("Card that will move")).toBeVisible({ timeout: 15_000 });
  // The card left the old column: applyEvent moved it, it did not duplicate it.
  await expect(column(mine.page, "To Do").getByText("Card that will move")).toHaveCount(0);
  await expect(column(theirs.page, "To Do").getByText("Card that will move")).toHaveCount(0);

  await theirs.context.close();
  await mine.context.close();
});

test("presence shows a teammate arriving, and drops them when their browser closes", async ({
  browser,
  user,
  teammate,
  board,
}) => {
  const mine = await openTab(browser, user);
  await mine.page.goto(`/boards/${board.id}`);
  // The room token names the caller, so presence is people, not socket ids —
  // and alone on a board that reads as nobody else, not "1 user".
  await expect(mine.page.getByText("Only you", { exact: true })).toBeVisible();

  const theirs = await openTab(browser, teammate.user);
  await theirs.page.goto(`/boards/${board.id}`);

  // The relay broadcasts `join` to whoever was already in the room...
  await expect(mine.page.getByText("1 other here", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(mine.page.getByTitle(teammate.user.email)).toBeVisible();

  // ...and answers the joiner with `initial_state`, so arriving second is not a
  // blind room. The navbar avatar is titled "Account menu", so an email title
  // on the page is a present teammate and nothing else.
  await expect(theirs.page.getByText("1 other here", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(theirs.page.getByTitle(user.email)).toBeVisible();

  // Closing the context closes the socket, which is the only signal the relay
  // gets that somebody left — there is no explicit "leave" message from the app.
  await theirs.context.close();

  await expect(mine.page.getByText("Only you", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(mine.page.getByTitle(teammate.user.email)).toHaveCount(0);

  await mine.context.close();
});

test("an event older than what the tab already holds is dropped, not applied", async ({
  browser,
  user,
  anon,
  api,
  board,
}) => {
  // version starts at 0 (packages/db/prisma/schema.prisma) and every write
  // increments it. This whole object becomes the stale frame later, unedited:
  // it is a genuine snapshot of the card as it was, not a forged shape.
  const card = await api.createIssue(board.section("TODO").id, "Guarded card");

  const mine = await openTab(browser, user);
  const frames = relayFrames(mine.page);
  await mine.page.goto(`/boards/${board.id}`);
  await expect(column(mine.page, "To Do").getByText("Guarded card")).toBeVisible();
  // The one tab here is alone, so presence cannot be the join gate: "Only you"
  // is also what a tab with no socket at all shows. The relay answers an
  // accepted join with initial_state, so that frame is the gate instead —
  // without it the move below can be published into a room this tab has not
  // reached yet, and the event is dropped with nothing to replay it.
  await expect.poll(() => frames.some((f) => f.includes("initial_state")), { timeout: 15_000 }).toBe(true);

  const moved = await api.moveIssue(card.id, board.section("DONE").id);
  expect(moved.ok()).toBe(true);
  const after = (await moved.json()) as { version: number };
  // The guard is a comparison, so the numbers have to actually differ.
  expect(after.version).toBeGreaterThan(card.version);
  await expect(column(mine.page, "Done").getByText("Guarded card")).toBeVisible({ timeout: 15_000 });

  // Replay the pre-move snapshot. applyEvent (routes/boards/$boardId.tsx) drops
  // an event whose issue.version is below the version already in the cache, so
  // this must not drag the card back to To Do. Out-of-order delivery is what
  // the field exists for; here it is provoked deliberately.
  const stale = await broadcast(anon, board.id, { type: "issue_moved", issue: card });
  // The relay wrote it to a socket, so "nothing happened" cannot mean "nothing
  // was sent" — the tab received the frame and chose to ignore it.
  expect(stale.delivered).toBeGreaterThanOrEqual(1);

  // A real write after the stale frame, on the same connection. Websocket
  // frames are ordered, so the moment this card renders the stale one has
  // already been handled — which is what makes the assertion below a fact
  // rather than a race won by a timeout.
  await api.createIssue(board.section("TODO").id, "Sentinel card");
  await expect(column(mine.page, "To Do").getByText("Sentinel card")).toBeVisible({ timeout: 15_000 });

  await expect(column(mine.page, "Done").getByText("Guarded card")).toBeVisible();
  await expect(column(mine.page, "To Do").getByText("Guarded card")).toHaveCount(0);

  await mine.context.close();
});

test("a tab on another board is never told about the first board's cards", async ({
  browser,
  user,
  teammate,
  api,
  org,
  board,
}) => {
  // A second board in the same organization: the teammate may read it, so the
  // only thing keeping the two apart is the relay's room, not authorization.
  const other = await api.createBoard(org.id, "Ops Board");
  const otherSections = await api.getSections(other.id);
  const otherTodo = otherSections.sections.find((s) => s.kind === "TODO");
  if (!otherTodo) throw new Error("the second board came up without a TODO column");

  const theirs = await openTab(browser, teammate.user);
  const frames = relayFrames(theirs.page);
  await theirs.page.goto(`/boards/${other.id}`);
  // initial_state is the relay's answer to an accepted join, so its arrival is
  // the proof this tab is in a room at all before anything is published.
  await expect
    .poll(() => frames.some((f) => f.includes("initial_state")), { timeout: 15_000 })
    .toBe(true);

  const mine = await openTab(browser, user);
  await mine.page.goto(`/boards/${board.id}`);
  const todo = column(mine.page, "To Do");
  await todo.getByRole("button", { name: "Add a card" }).click();
  await todo.getByPlaceholder("Enter a title").fill("Board one card");
  await todo.getByRole("button", { name: "Add issue" }).click();
  await expect(todo.getByText("Board one card")).toBeVisible();

  // Positive control. Without it, "the other tab saw nothing" would also be
  // true of a tab whose socket never connected.
  await api.createIssue(otherTodo.id, "Board two card");
  await expect(column(theirs.page, "To Do").getByText("Board two card")).toBeVisible({ timeout: 15_000 });

  // Asserted on the wire, not on the screen: a board page would never render
  // another board's card even if the relay leaked it, so the DOM cannot tell
  // room isolation apart from per-board queries.
  expect(frames.some((f) => f.includes("Board two card"))).toBe(true);
  expect(frames.some((f) => f.includes("Board one card"))).toBe(false);
  expect(frames.some((f) => f.includes(board.id))).toBe(false);
  // And the first board's occupant is not a presence in this room either.
  await expect(theirs.page.getByText("Only you", { exact: true })).toBeVisible();

  await mine.context.close();
  await theirs.context.close();
});
