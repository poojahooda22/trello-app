import type { Page } from "@playwright/test";

import { test, expect, type ApiClient, type Issue, type Section, type SectionKind } from "../fixtures";

/**
 * Cards: making them, reading them, changing them, deleting them.
 *
 * The board and the issue page are two views of one row, so most of these
 * specs write on one surface and read on the other — that is where the
 * interesting failures live (a save that never invalidated the board, a
 * delete that left the card behind). Setup goes over the API; only the step
 * under test is clicked.
 */

/**
 * A column, addressed by the heading inside it.
 *
 * The five columns are identical <section>s — same "Add a card" button, same
 * shape — and a <section> with no accessible name is not exposed as a region,
 * so there is no role to ask for. Scoping by the heading beats taking the
 * second button on the page: if the default columns ever change order, this
 * fails loudly instead of quietly testing the wrong column.
 */
function column(page: Page, title: string) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

/** The card as the server holds it now, including the fields no screen renders. */
async function cardOnBoard(api: ApiClient, boardId: string, issueId: string): Promise<Issue> {
  const { sections } = await api.getSections(boardId);
  const found = sections.flatMap((s) => s.issues).find((i) => i.id === issueId);
  if (!found) throw new Error(`issue ${issueId} is not on board ${boardId}`);
  return found;
}

/** What `board.section(kind)` does, for the extra boards a spec makes itself. */
function sectionOf(sections: Section[], kind: SectionKind): Section {
  const found = sections.find((s) => s.kind === kind);
  if (!found) throw new Error(`board has no ${kind} column; got ${sections.map((s) => s.kind).join(", ")}`);
  return found;
}

/**
 * Runs an action on the issue page and returns the write it triggered.
 *
 * The priority buttons only restyle themselves, so there is nothing on screen
 * to wait for, and navigating away while the PUT is in flight would cancel it
 * mid-request. Waiting on the response is the honest signal that the change
 * reached the database.
 */
async function issueWrite(page: Page, issueId: string, act: () => Promise<void>) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/issue/${issueId}`) && r.request().method() === "PUT"),
    act(),
  ]);
  return response;
}

test("a card added from a column's composer lands in that column", async ({ page, api, board }) => {
  await page.goto(`/boards/${board.id}`);

  const todo = column(page, "To Do");
  await todo.getByRole("button", { name: "Add a card" }).click();
  await page.getByPlaceholder("Enter a title").fill("Restock the dark store");
  await page.getByRole("button", { name: "Add issue" }).click();

  await expect(todo.getByText("Restock the dark store")).toBeVisible();
  // keyPrefixFor("Zepto Board") === "ZEP", and this is the board's first card.
  await expect(todo.getByText("ZEP-1", { exact: true })).toBeVisible();
  // One `title` state and one open composer are shared by every column, so
  // "it went into the column I clicked" is a real claim, not a tautology.
  await expect(column(page, "Backlog").getByText("Restock the dark store")).toHaveCount(0);
  // Submitting closes the composer rather than leaving it open with stale text.
  await expect(page.getByPlaceholder("Enter a title")).toHaveCount(0);

  // The board renders the mutation's own response, so read the row back
  // independently: an optimistic patch that never persisted looks identical.
  const { sections } = await api.getSections(board.id);
  expect(sectionOf(sections, "TODO").issues.map((i) => i.title)).toEqual(["Restock the dark store"]);
});

test("card keys count up once per board, and a second board starts again at one", async ({
  page,
  api,
  org,
  board,
}) => {
  // Two columns, one counter: the number belongs to the board, not the column.
  const first = await api.createIssue(board.section("TODO").id, "Pick the order");
  const second = await api.createIssue(board.section("BACKLOG").id, "Print the label");
  expect([first.key, second.key]).toEqual(["ZEP-1", "ZEP-2"]);

  await page.goto(`/boards/${board.id}`);
  await expect(column(page, "To Do").getByText("ZEP-1", { exact: true })).toBeVisible();
  await expect(column(page, "Backlog").getByText("ZEP-2", { exact: true })).toBeVisible();

  // A second board in the same workspace gets its own prefix
  // (keyPrefixFor("Blinkit Board") === "BLI") and its own counter — the first
  // card there is BLI-1, not BLI-3.
  const other = await api.createBoard(org.id, "Blinkit Board");
  const otherSections = await api.getSections(other.id);
  const otherFirst = await api.createIssue(sectionOf(otherSections.sections, "TODO").id, "Assign a rider");
  expect(otherFirst.key).toBe("BLI-1");

  await page.goto(`/boards/${other.id}`);
  await expect(page.getByText("BLI-1", { exact: true })).toBeVisible();
  // Same workspace, different board: the first board's cards must not leak in.
  await expect(page.getByText("ZEP-1", { exact: true })).toHaveCount(0);
});

test("a card opens its issue page by pointer and by keyboard", async ({ page, api, board }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Refund the cancelled order");
  // The keyboard half needs a card in Done; see the comment on it below.
  const sealed = await api.createIssue(board.section("DONE").id, "Weekly ledger reconciled");
  await page.goto(`/boards/${board.id}`);

  const card = page.getByRole("button", { name: new RegExp(issue.key) });
  // The card separates a click from a drop by how far the pointer travelled
  // between down and up, so a plain click — no movement — has to open the page.
  await card.click();

  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}/issues/${issue.id}$`));
  // The headline is the title — what the person came for. The key is the
  // citation, kept on the line below with where the card lives.
  await expect(page.getByRole("heading", { name: "Refund the cancelled order", level: 1 })).toBeVisible();
  await expect(page.getByText(`${issue.key} · ${board.title} · To Do`)).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Refund the cancelled order");
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("");
  await expect(page.getByText("No comments yet.")).toBeVisible();
  await expect(page.getByText("Nobody yet.")).toBeVisible();
  await expect(page.getByText("No labels.")).toBeVisible();
  // The E2E stack runs with no GitHub app and no Slack webhook. The page has to
  // say so plainly instead of offering links it cannot honour.
  await expect(page.getByText("No repository linked to this board.")).toBeVisible();
  await expect(page.getByText("No Slack channel connected.")).toBeVisible();

  await page.getByRole("link", { name: "Back to board" }).click();
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}$`));

  // A card is also a keyboard control — but only where it is not draggable,
  // and that is not this spec's choice to make.
  //
  // dnd-kit binds its KeyboardSensor's keydown listener on the card element
  // itself, treats Space and Enter as "start a drag", and opens handleStart
  // with preventDefault() + stopImmediatePropagation()
  // (@dnd-kit/dom@0.5.0/index.js: keyboardCodes.start = ["Space","Enter"],
  // bind() -> target.addEventListener("keydown"), handleStart()). React 19
  // delegates onKeyDown to the root container, so stopping the event at the
  // <li> means issue-card.tsx's handler never runs: on a draggable card Enter
  // starts a keyboard drag and navigates nowhere.
  //
  // Done is the one column ALLOWED leaves empty, so IssueCard passes
  // disabled:true, handleSourceKeyDown bails on `source.disabled`, and the
  // event reaches React. That is the only path on which the handler is live
  // today — the other four columns are a real keyboard gap in the component,
  // not something to assert away here.
  await page.getByRole("button", { name: new RegExp(sealed.key) }).press("Enter");
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}/issues/${sealed.id}$`));
});

test("ticking a card's checkbox moves it to Done without opening it", async ({ page, api, board }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Reconcile the courier invoice");
  await page.goto(`/boards/${board.id}`);

  // The box beside the key is a real control with a role and a state, not a
  // type glyph: one name in both states, unticked while the card sits
  // anywhere but Done. The card's own name stays title + key — the box's
  // label must not leak into it.
  const box = page.getByRole("checkbox", { name: `${issue.key} done`, exact: true });
  const card = page.getByRole("button", { name: `Reconcile the courier invoice ${issue.key}`, exact: true });
  await expect(card).toBeVisible();
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();

  // Ticking is the same move a drop into Done makes, so the same request.
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/issue/move") && r.request().method() === "PUT"),
    box.click(),
  ]);
  expect(response.status()).toBe(200);

  // The click belonged to the box, not to the card around it: still on the
  // board, not on the issue page.
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}$`));
  await expect(column(page, "Done").getByText("Reconcile the courier invoice")).toBeVisible();
  expect((await cardOnBoard(api, board.id, issue.id)).sectionId).toBe(board.section("DONE").id);
  // The card re-mounted in Done and took the focus the box had, so a keyboard
  // user is not dropped back at the top of the document.
  await expect(card).toBeFocused();

  // Done is terminal for people (move-rules.spec.ts), so the tick has no undo
  // here: ticked, inert, and no longer a tab stop.
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();
  await expect(box).toHaveAttribute("tabindex", "-1");
});

test("an edited title and description survive a reload and reach the board", async ({ page, api, board }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Rider app crashes on cold start");
  await page.goto(`/boards/${board.id}/issues/${issue.id}`);

  const titleField = page.getByLabel("Title", { exact: true });
  const descriptionField = page.getByLabel("Description", { exact: true });
  const renamed = "Rider app crashes on cold start (Android 14)";
  const described = "Reproduces on a cleared cache. The boot path reads the token before it exists.";

  await titleField.fill(renamed);
  await descriptionField.fill(described);
  // The page tracks its own unsaved state; the banner appearing and then going
  // is the mutation starting and finishing, with no timing guessed at.
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Unsaved changes")).toBeHidden();

  // A reload throws away every client cache, so what comes back is the row.
  await page.reload();
  await expect(titleField).toHaveValue(renamed);
  await expect(descriptionField).toHaveValue(described);

  // The board reads the same row back. This is deliberately NOT a claim about
  // the save's invalidateQueries: the reload above emptied every cache, and the
  // app builds its QueryClient with the defaults (staleTime 0, refetchOnMount),
  // so mounting the board route refetches whether or not anything invalidated
  // it. A missing invalidation is not observable from a browser here.
  await page.getByRole("link", { name: "Back to board" }).click();
  await expect(column(page, "To Do").getByText(renamed)).toBeVisible();
});

test("priority is set from the issue page and cleared by pressing the same button again", async ({
  page,
  api,
  board,
}) => {
  const issue = await api.createIssue(board.section("TODO").id, "Warehouse count is off by two");
  await page.goto(`/boards/${board.id}/issues/${issue.id}`);

  // The glyph is part of the button's text ("⌃ High"), so match the word alone.
  const high = page.getByRole("button", { name: /High/ });
  expect((await issueWrite(page, issue.id, () => high.click())).status()).toBe(200);

  await page.goto(`/boards/${board.id}`);
  // On the card the priority is a bare glyph; its title attribute is the only
  // thing that names it, for this spec and for a screen reader alike.
  await expect(page.getByTitle("High priority")).toBeVisible();

  // Pressing the priority that is already set is how the UI clears it — there
  // is no separate "none" button.
  await page.goto(`/boards/${board.id}/issues/${issue.id}`);
  expect((await issueWrite(page, issue.id, () => high.click())).status()).toBe(200);

  await page.goto(`/boards/${board.id}`);
  await expect(page.getByText("Warehouse count is off by two")).toBeVisible();
  await expect(page.getByTitle("High priority")).toHaveCount(0);
});

test("deleting a card from the danger zone takes it off the board", async ({ page, api, board }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Duplicate promo banner");
  await page.goto(`/boards/${board.id}/issues/${issue.id}`);

  // Cancel first: the confirmation has to be a real gate, not decoration.
  await page.getByRole("button", { name: "Delete this issue" }).click();
  await expect(page.getByText(`Delete ${issue.key} permanently?`)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(`Delete ${issue.key} permanently?`)).toBeHidden();
  expect((await cardOnBoard(api, board.id, issue.id)).id).toBe(issue.id);

  await page.getByRole("button", { name: "Delete this issue" }).click();
  await page.getByRole("button", { name: "Yes, delete" }).click();

  // Deleting leaves you on the board the card was on — staying on a page whose
  // row no longer exists would only render its 404.
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}$`));
  // This test never opened the board, so its query is cold and the route lands
  // on "Loading board…" first. Wait for a column before asserting an absence,
  // or "the card is gone" is only a statement about a board that has not
  // rendered yet — true of every card, including one the delete missed.
  await expect(column(page, "To Do").getByRole("button", { name: "Add a card" })).toBeVisible();
  await expect(page.getByText("Duplicate promo banner")).toHaveCount(0);

  const { sections } = await api.getSections(board.id);
  expect(sections.flatMap((s) => s.issues)).toEqual([]);
});

test("the issues list shows every card on the board and filters it down", async ({ page, api, board }) => {
  const restock = await api.createIssue(board.section("TODO").id, "Restock the dark store");
  const refund = await api.createIssue(board.section("DONE").id, "Refund the cancelled order");
  const rewrite = await api.createIssue(board.section("BACKLOG").id, "Rewrite the picker route");

  await page.goto(`/boards/${board.id}/issues`);
  await expect(page.getByRole("heading", { name: "Issues", level: 1 })).toBeVisible();
  // "<matching> of <total>" is how the header says whether a filter is on.
  await expect(page.getByText("3 of 3")).toBeVisible();

  // The list is flat across columns — every card on the board, whichever
  // column it sits in, which is the whole point of this view.
  for (const issue of [restock, refund, rewrite]) {
    await expect(page.getByText(issue.key, { exact: true })).toBeVisible();
    await expect(page.getByText(issue.title)).toBeVisible();
  }

  const filter = page.getByLabel("Filter issues");
  await filter.fill("refund");
  await expect(page.getByText("1 of 3")).toBeVisible();
  await expect(page.getByText(refund.title)).toBeVisible();
  await expect(page.getByText(restock.title)).toHaveCount(0);

  // The same box matches keys, lowercased on both sides — "zep-3" finds ZEP-3.
  await filter.fill(rewrite.key.toLowerCase());
  await expect(page.getByText("1 of 3")).toBeVisible();
  await expect(page.getByText(rewrite.title)).toBeVisible();

  await filter.fill("nothing on this board says this");
  await expect(page.getByText("No issues match.")).toBeVisible();

  // Column and text are separate filters; clearing one must not clear the other.
  await filter.fill("");
  await page.getByLabel("Filter by column").selectOption({ label: "Done" });
  await expect(page.getByText("1 of 3")).toBeVisible();
  await expect(page.getByText(refund.title)).toBeVisible();
  await expect(page.getByText(restock.title)).toHaveCount(0);

  await page.getByRole("link", { name: new RegExp(refund.key) }).click();
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}/issues/${refund.id}$`));
});

test("every write bumps the card's version", async ({ page, api, board }) => {
  const created = await api.createIssue(board.section("TODO").id, "Ledger drifts after a retry");
  // A new row starts at 0. The number is on no screen: it exists so an open
  // board can drop a socket event older than what its cache already holds,
  // which only works if every write moves it.
  expect(created.version).toBe(0);

  await page.goto(`/boards/${board.id}/issues/${created.id}`);
  await page.getByLabel("Title", { exact: true }).fill("Ledger drifts after a retried write");
  const saved = await issueWrite(page, created.id, () =>
    page.getByRole("button", { name: "Save changes" }).click(),
  );
  expect(((await saved.json()) as { version: number }).version).toBe(1);

  // A second write of a different field, to prove the bump is per write and not
  // something the title update does on its own.
  const prioritised = await issueWrite(page, created.id, () =>
    page.getByRole("button", { name: /Urgent/ }).click(),
  );
  expect(((await prioritised.json()) as { version: number }).version).toBe(2);

  // Echoed to this tab is not the same as stored: read the row back cold.
  expect((await cardOnBoard(api, board.id, created.id)).version).toBe(2);
});
