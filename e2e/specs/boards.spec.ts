import { test, expect, type SectionKind } from "../fixtures";
import { API_URL } from "../env";

/**
 * Boards and columns: the board list, the board header, and the five columns
 * every board is born with.
 *
 * Two things in this domain have no UI at all — the frontend never calls
 * DELETE /board/:boardId, POST /section, PUT /section/:sectionId or
 * DELETE /section/:sectionId (grep apps/frontend/src for them and nothing comes
 * back). Those writes therefore go through `api.raw()`, and what the browser is
 * asked to prove is that the board renders the result: a deleted board is gone
 * from the workspace and unreachable, a custom column appears after the five
 * defaults, and deleting it takes its cards with it. When that UI lands, only
 * the write lines here should need to change.
 *
 * Those writes are also seeded before navigation rather than watched arriving
 * over the socket. The backend does publish section_added / section_updated /
 * section_deleted and $boardId.tsx invalidates on them, but that path belongs to
 * the realtime spec; here a reload keeps every assertion about the board's own
 * rendering.
 */

/** DEFAULT_SECTIONS in apps/backend/board-rules.ts, in position order. */
const DEFAULT_COLUMNS = ["Backlog", "To Do", "In Progress", "Review", "Done"];

/** SECTION_KINDS in apps/backend/board-rules.ts — the kinds DELETE /section refuses. */
const WORKFLOW_KINDS: SectionKind[] = ["BACKLOG", "TODO", "INPROGRESS", "REVIEW", "DONE"];

/**
 * The sidebar's selected row is styled and nothing more — app-sidebar.tsx puts
 * no aria-current on the links, so this background token is the only handle the
 * DOM offers for "selected". The bare token is matched deliberately: the same
 * name also appears as `hover:bg-surface-hover`, which says nothing about
 * selection on its own.
 */
const SELECTED = /(?:^|\s)bg-surface-hover(?:\s|$)/;

test("the boards page lists each workspace with the boards inside it", async ({ page, api, org, board }) => {
  const second = await api.createBoard(org.id, "Photon Metrics");

  await page.goto("/boards");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your workspaces");
  await expect(page.getByRole("heading", { level: 2, name: org.name })).toBeVisible();
  // The badge is the caller's role, not decoration: ADMIN is what lets the
  // deletion test further down succeed, and a MEMBER would read MEMBER here.
  await expect(page.getByText("ADMIN", { exact: true })).toBeVisible();

  const tile = page.getByRole("link", { name: second.title });
  await expect(page.getByRole("link", { name: board.title })).toBeVisible();
  await expect(tile).toBeVisible();

  await tile.click();
  await expect(page).toHaveURL(new RegExp(`/boards/${second.id}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Photon Metrics");
});

test("a board created from the boards page opens with the five default columns in order", async ({ page, org }) => {
  // No `board` fixture on purpose: this test creates the only board the
  // workspace has, so the tile it clicks can only be the one it just made.
  await page.goto("/boards");
  await expect(page.getByRole("heading", { level: 2, name: org.name })).toBeVisible();

  await page.getByRole("button", { name: "Create new board" }).click();
  await page.getByPlaceholder("Board title").fill("Photon Metrics");
  // Exact: the create-a-workspace form sits on the same page and its button is
  // named "Create workspace".
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const tile = page.getByRole("link", { name: "Photon Metrics" });
  await expect(tile).toBeVisible();
  await tile.click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Photon Metrics");
  // Order is as much of the contract as membership — the GitHub automation moves
  // cards by kind, and a reader reads left to right. The columns are the only
  // level-2 headings on this page, so this also asserts there are exactly five.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(DEFAULT_COLUMNS);
});

test("the pencil in the board header renames the board", async ({ page, api, board }) => {
  await page.goto(`/boards/${board.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(board.title);

  // Double-clicking the title does the same thing, but nothing on screen says
  // so. The pencil is the discoverable affordance, and it is a real button in
  // the DOM even while md:opacity-0 hides it until the header is hovered — so
  // clicking it needs no hover dance.
  await page.getByRole("button", { name: "Rename board" }).click();

  const field = page.getByRole("textbox", { name: "Board name" });
  // Focus is the whole point of the affordance: one click and you are typing.
  await expect(field).toBeFocused();
  await field.fill("Quantum Ledger");
  await field.press("Enter");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quantum Ledger");
  // Committing puts the heading back, pencil and all, rather than leaving the
  // header stuck in edit mode.
  await expect(page.getByRole("button", { name: "Rename board" })).toBeVisible();

  // A fresh load, so this is the server's title and not the header's own state.
  await page.goto("/boards");
  await expect(page.getByRole("link", { name: "Quantum Ledger" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Zepto Board" })).toHaveCount(0);

  // The key prefix is derived once, when the board is created. A rename must not
  // re-derive it, or every key already printed on a card — and quoted in a
  // branch name that parseIssueKey reads — stops resolving.
  const after = await api.createIssue(board.section("TODO").id, "Card added after the rename");
  expect(after.key).toBe("ZEP-1");
});

test("Escape abandons a rename instead of writing it", async ({ page, board }) => {
  await page.goto(`/boards/${board.id}`);
  // The pencil is in the DOM from the first paint, but the title behind it is
  // not: $boardId.tsx reads the board out of a useQueries over the workspace
  // board lists, and the click handler seeds the draft with `board?.title ?? ""`.
  // Clicking before that resolves opens the editor on an empty string, which is
  // not the state this test means to abandon.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(board.title);
  await page.getByRole("button", { name: "Rename board" }).click();

  const field = page.getByRole("textbox", { name: "Board name" });
  await field.fill("Typed but never wanted");
  await field.press("Escape");

  // Escape clears the draft, and clearing it unmounts the input before its blur
  // handler — which does commit — can reach React's delegated listener.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(board.title);
  // The reload is the real assertion: nothing reached the database on the way out.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(board.title);
});

test("the card key prefix comes from the board title, with BRD as the fallback", async ({ page, api, org, board }) => {
  // keyPrefixFor("Zepto Board"): non-alphanumerics out, first three letters up.
  const zep = await api.createIssue(board.section("TODO").id, "A card on the well-named board");
  expect(zep.key).toBe("ZEP-1");

  // Leading digits are stripped because the key parser needs a letter first, so
  // an all-digit title has nothing left to slice and takes the BRD fallback.
  const numeric = await api.createBoard(org.id, "2024");
  const { sections } = await api.getSections(numeric.id);
  const todo = sections.find((s) => s.kind === "TODO");
  if (!todo) throw new Error("a freshly created board should have a TODO column");
  const brd = await api.createIssue(todo.id, "A card on the awkwardly named board");
  expect(brd.key).toBe("BRD-1");

  // The keys the cards actually print, not just what the API returned.
  await page.goto(`/boards/${board.id}`);
  await expect(page.getByText("ZEP-1", { exact: true })).toBeVisible();

  await page.goto(`/boards/${numeric.id}`);
  await expect(page.getByText("BRD-1", { exact: true })).toBeVisible();
});

test("a deleted board leaves the workspace and its page reports it is gone", async ({ page, api, org, board }) => {
  // The last assertion below has to sit out React Query's retry ladder, so it
  // asks for 20s of the config's 30s test budget on its own — leaving ten for
  // the fixtures and two full page loads against a frontend that bundles on
  // first request. Tripling the budget costs nothing on a run that passes.
  test.slow();

  const kept = await api.createBoard(org.id, "Kept Board");
  const { request, headers } = api.raw();

  // No delete affordance in the UI yet — see the note at the top of this file.
  // The route is admin-only, and the creator of an organization is its admin.
  const deleted = await request.delete(`${API_URL}/board/${board.id}`, { headers });
  expect(deleted.status()).toBe(204);

  await page.goto("/boards");
  // The surviving tile first: on its own, "the deleted tile is absent" would
  // also pass while the boards query was still in flight.
  await expect(page.getByRole("link", { name: kept.title })).toBeVisible();
  await expect(page.getByRole("link", { name: board.title })).toHaveCount(0);

  await page.goto(`/boards/${board.id}`);
  // GET /sections answers 404 "Not found" and lib/api.ts surfaces the server's
  // message verbatim. React Query's default ladder retries three times (1s, 2s,
  // 4s) before isError flips, which outlasts the config's 10s expect timeout.
  await expect(page.getByText("Not found")).toBeVisible({ timeout: 20_000 });
});

test("a custom column is added after the defaults, renames, and deletes with its cards", async ({
  page,
  api,
  board,
}) => {
  const { request, headers } = api.raw();

  const created = await request.post(`${API_URL}/section`, { headers, data: { boardId: board.id, title: "Blocked" } });
  expect(created.status()).toBe(201);
  const column = (await created.json()) as { id: string; kind: string | null };
  // Having no kind is what makes it custom: it sits outside the workflow the
  // GitHub automation moves cards through, and it is the only sort of column the
  // backend will let anyone delete.
  expect(column.kind).toBeNull();

  await page.goto(`/boards/${board.id}`);
  // nextSectionPosition appends, so a new column lands to the right of Done
  // rather than in the middle of the workflow.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText([...DEFAULT_COLUMNS, "Blocked"]);

  const parked = await api.createIssue(column.id, "Waiting on legal");
  await page.reload();
  await expect(page.getByText(parked.title)).toBeVisible();

  const renamed = await request.put(`${API_URL}/section/${column.id}`, { headers, data: { title: "On Hold" } });
  expect(renamed.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText([...DEFAULT_COLUMNS, "On Hold"]);
  // A rename moves nothing: the card is still parked in the column it was in.
  await expect(page.getByText(parked.title)).toBeVisible();

  const removed = await request.delete(`${API_URL}/section/${column.id}`, { headers });
  expect(removed.status()).toBe(204);
  await page.reload();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(DEFAULT_COLUMNS);
  // The heading assertion above already proves the board's data arrived, so an
  // absent card here is a deleted card rather than an unfinished fetch. The row
  // goes with the column: Issue.section cascades.
  await expect(page.getByText(parked.title)).toHaveCount(0);
});

test("the five workflow columns cannot be deleted", async ({ api, board }) => {
  const { request, headers } = api.raw();

  // Why the test above needs a custom column: the kinded five are the contract
  // the GitHub automation moves cards through, so the backend refuses. All five
  // and not one of them — the guard is `section.kind !== null`, so a regression
  // that exempted a single kind would still pass a DONE-only check while the
  // test's name went on claiming otherwise.
  for (const kind of WORKFLOW_KINDS) {
    const res = await request.delete(`${API_URL}/section/${board.section(kind).id}`, { headers });
    expect(res.status(), `DELETE on the ${kind} column`).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error, `DELETE on the ${kind} column`).toBe("Default columns cannot be deleted");
  }
});

test("the sidebar highlights exactly one item and navigates between the three views", async ({ page, org, board }) => {
  const sidebar = page.getByRole("complementary");
  const home = sidebar.getByRole("link", { name: "Home" });
  const boards = sidebar.getByRole("link", { name: "Boards" });
  const workspace = sidebar.getByRole("link", { name: org.name });

  // Home and Boards both point at /boards, so per-link route matching lit the
  // two together. Every stop below asserts the other two rows are dark, which is
  // the half that regresses if selection goes back to being matched per link.
  await page.goto(`/boards/${board.id}`);
  await expect(boards).toHaveClass(SELECTED);
  await expect(home).not.toHaveClass(SELECTED);
  await expect(workspace).not.toHaveClass(SELECTED);

  await home.click();
  await expect(page).toHaveURL(/\/boards$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your workspaces");
  await expect(home).toHaveClass(SELECTED);
  await expect(boards).not.toHaveClass(SELECTED);
  await expect(workspace).not.toHaveClass(SELECTED);

  await workspace.click();
  // ?org= lives in the URL rather than in state so the filtered view is linkable.
  await expect(page).toHaveURL(new RegExp(`/boards\\?org=${org.id}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(org.name);
  // Scoped to one workspace, creating another is out of the way.
  await expect(page.getByPlaceholder("New workspace name")).toHaveCount(0);
  await expect(page.getByRole("link", { name: board.title })).toBeVisible();
  await expect(workspace).toHaveClass(SELECTED);
  await expect(home).not.toHaveClass(SELECTED);
  await expect(boards).not.toHaveClass(SELECTED);

  // Templates is shown but inert until there is a backend for it, so it is a
  // span and not a link — the one row that can never be selected.
  await expect(sidebar.getByRole("link", { name: "Templates" })).toHaveCount(0);
  await expect(sidebar.getByText("Templates")).toBeVisible();
});
