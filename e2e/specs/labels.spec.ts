import type { Locator, Page } from "@playwright/test";

import { API_URL } from "../env";
import { expect, test } from "../fixtures";

/**
 * Labels and priority — the two things a card carries besides its title, and
 * the two the board says with colour rather than with words.
 *
 * Because colour is the whole feature, these specs read computed styles.
 * `bg-[#E9F2FF]` is an implementation detail and asserting on the class name
 * would pass a repaint that never reached the screen; "the blue label is
 * painted #E9F2FF" is the promise. Every expected value below is copied from
 * apps/frontend/src/lib/issue-style.ts, which is the one place cards, the
 * issue list and the detail page all read their palette from.
 */

/**
 * LABEL_CLASS, minus `grey`. These six are fixed hexes, so they survive a
 * theme switch; grey alone is a theme token (`--surface-subtle`) and is read
 * off the document instead of pinned here.
 */
const LABEL_BACKGROUND = {
  blue: "#E9F2FF",
  green: "#DFFCF0",
  yellow: "#FFF7D6",
  orange: "#FFF3EB",
  red: "#FFECEB",
  purple: "#F3F0FF",
} as const;

const LABEL_COLORS = ["grey", "blue", "green", "yellow", "orange", "red", "purple"] as const;

/**
 * PRIORITY_MARK. The glyphs are U+2303 (URGENT twice, HIGH once) and U+2304 —
 * URGENT being two of the character HIGH uses once is why the assertions below
 * match the badge's whole text rather than a substring of it.
 */
const PRIORITY_MARK = {
  URGENT: { glyph: "⌃⌃", color: "#AE2E24", title: "Urgent priority" },
  HIGH: { glyph: "⌃", color: "#A54800", title: "High priority" },
  MEDIUM: { glyph: "=", color: "#7F5F01", title: "Medium priority" },
  LOW: { glyph: "⌄", color: "#0055CC", title: "Low priority" },
} as const;

/** The source writes hex; Chromium reports "rgb(r, g, b)". */
function rgb(hex: string): string {
  const n = parseInt(hex.trim().replace("#", ""), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

const backgroundOf = (chip: Locator) => chip.evaluate((el) => getComputedStyle(el).backgroundColor);
const inkOf = (mark: Locator) => mark.evaluate((el) => getComputedStyle(el).color);

/** What `grey` resolves to right now, light or dark, straight from the theme. */
const greySwatch = async (page: Page) =>
  rgb(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface-subtle")));

/**
 * A card is an `<li role="button">` — the whole card is the control that opens
 * the issue. Scoping by its title is what stops one card's chips from
 * answering an assertion about another's.
 */
const card = (page: Page, title: string) => page.getByRole("button").filter({ hasText: title });

/**
 * The Labels panel says "attached or not" in two shapes: a label the card does
 * not carry is offered as a "+ Name" button, and one it does carry is a chip
 * with a "Remove Name" control. The regex tolerates the space in "+ Name"
 * being normalised away when the accessible name is computed.
 */
const offered = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^\\+\\s*${name}$`) });
const attached = (page: Page, name: string) => page.getByRole("button", { name: `Remove ${name}`, exact: true });

test("every label colour paints its own swatch on the card", async ({ page, api, board }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Swatch card");
  // Naming each label after its colour keeps the chip and the assertion about
  // it in one line of the loop below.
  for (const color of LABEL_COLORS) {
    const label = await api.createLabel(board.id, color, color);
    expect(label.color).toBe(color);
    await api.addLabel(issue.id, label.id);
  }

  await page.goto(`/boards/${board.id}`);

  const grey = await greySwatch(page);
  const painted: string[] = [];
  for (const color of LABEL_COLORS) {
    const chip = card(page, "Swatch card").getByText(color, { exact: true });
    await expect(chip).toBeVisible();
    painted.push(await backgroundOf(chip));
  }

  expect(painted).toEqual(LABEL_COLORS.map((c) => (c === "grey" ? grey : rgb(LABEL_BACKGROUND[c]))));
  // Seven colours have to be seven colours. Every check above would still pass
  // if two rows of the palette were edited into the same value.
  expect(new Set(painted).size).toBe(LABEL_COLORS.length);
});

test("a label typed on the issue page is created grey and lands on the card", async ({ page, api, board }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Chore card");

  await page.goto(`/boards/${board.id}/issues/${issue.id}`);
  await expect(page.getByText("No labels.")).toBeVisible();

  await page.getByPlaceholder("New label").fill("Chore");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // The form creates and then attaches in one gesture, so the proof is the
  // chip's own control appearing — the name alone would also show up in the
  // "+ Chore" offer list, which would mean created but not attached.
  await expect(attached(page, "Chore")).toBeVisible();

  // The form sends no colour, so the server's default is what gets stored.
  // There is no colour picker anywhere in the UI; the other six only ever
  // arrive over the API.
  expect(await backgroundOf(page.getByText("Chore", { exact: true }))).toBe(await greySwatch(page));

  await page.goto(`/boards/${board.id}`);
  await expect(card(page, "Chore card").getByText("Chore", { exact: true })).toBeVisible();
});

test("a second label with an existing name reuses the one row", async ({ page, api, board }) => {
  const original = await api.createLabel(board.id, "Regression", "red");
  const issue = await api.createIssue(board.section("TODO").id, "Duplicate card");

  await page.goto(`/boards/${board.id}/issues/${issue.id}`);
  // The board already has this label and offers it…
  await expect(offered(page, "Regression")).toBeVisible();
  // …but someone who did not look types the name in again anyway.
  await page.getByPlaceholder("New label").fill("Regression");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(attached(page, "Regression")).toBeVisible();
  await expect(offered(page, "Regression")).toHaveCount(0);

  // @@unique([boardId, name]) is enforced by an upsert, not by a 4xx: the
  // second POST resolves onto the first row and returns 201 with its id. The
  // user sees no error, and the board still has exactly one Regression — which
  // is the behaviour worth pinning, because a rejection here would be a
  // visible change of contract, not a bug fix.
  const { request, headers } = api.raw();
  // The route is a bare `prisma.label.findMany` with no `select`
  // (apps/backend/index.ts:1006), so each row carries every scalar on the
  // model — `boardId` included (packages/db/prisma/schema.prisma:139). Hence
  // toMatchObject: what this test pins is one row, that id, that colour, not
  // the full column list of the table.
  const listed = (await (await request.get(`${API_URL}/board/${board.id}/labels`, { headers })).json()) as {
    id: string;
    boardId: string;
    name: string;
    color: string;
  }[];
  expect(listed.filter((l) => l.name === "Regression")).toMatchObject([
    // Red, not grey: the form omits `color`, and the upsert's update leaves an
    // omitted colour alone rather than resetting it to the default.
    { id: original.id, name: "Regression", color: "red" },
  ]);
  expect(await backgroundOf(page.getByText("Regression", { exact: true }))).toBe(rgb(LABEL_BACKGROUND.red));
});

test("a label attaches and detaches from a card through the issue page", async ({ page, api, board }) => {
  await api.createLabel(board.id, "Blocked", "orange");
  const issue = await api.createIssue(board.section("TODO").id, "Attachable card");
  const issuePath = `/boards/${board.id}/issues/${issue.id}`;

  await page.goto(issuePath);
  await expect(page.getByText("No labels.")).toBeVisible();

  await offered(page, "Blocked").click();
  await expect(attached(page, "Blocked")).toBeVisible();

  await page.goto(`/boards/${board.id}`);
  const chip = card(page, "Attachable card").getByText("Blocked", { exact: true });
  await expect(chip).toBeVisible();
  expect(await backgroundOf(chip)).toBe(rgb(LABEL_BACKGROUND.orange));

  await page.goto(issuePath);
  await attached(page, "Blocked").click();
  // Detaching returns the label to the offer list rather than deleting it —
  // the card lost it, the board did not.
  await expect(page.getByText("No labels.")).toBeVisible();
  await expect(offered(page, "Blocked")).toBeVisible();

  await page.goto(`/boards/${board.id}`);
  // Wait for the card itself before asserting an absence, or a board that has
  // simply not finished loading would pass.
  await expect(card(page, "Attachable card")).toBeVisible();
  await expect(page.getByText("Blocked", { exact: true })).toHaveCount(0);
});

test("deleting a board label clears it from every card that carried it", async ({ page, api, board }) => {
  const doomed = await api.createLabel(board.id, "Deprecated", "red");
  const keeper = await api.createLabel(board.id, "Keep", "green");
  const first = await api.createIssue(board.section("TODO").id, "First card");
  const second = await api.createIssue(board.section("BACKLOG").id, "Second card");
  await api.addLabel(first.id, doomed.id);
  await api.addLabel(first.id, keeper.id);
  await api.addLabel(second.id, doomed.id);

  await page.goto(`/boards/${board.id}`);
  await expect(card(page, "First card").getByText("Deprecated", { exact: true })).toBeVisible();
  await expect(card(page, "Second card").getByText("Deprecated", { exact: true })).toBeVisible();

  // The issue page has a delete control too (the spec after this one drives
  // it); this one pins the cascade itself, straight at the route.
  const { request, headers } = api.raw();
  expect((await request.delete(`${API_URL}/label/${doomed.id}`, { headers })).status()).toBe(204);

  // DELETE /label/:labelId publishes issue_updated for every card that carried
  // the label, so an open board drops it live. This spec reloads anyway: what
  // it pins is the IssueLabel cascade in the database, not the socket path.
  await page.reload();

  // Both cards first, then the absence. The count assertion below covers the
  // whole board, so both cards have to be on screen before it means anything —
  // "First card rendered" alone would let a missing Second card read as a pass.
  await expect(card(page, "First card").getByText("Keep", { exact: true })).toBeVisible();
  await expect(card(page, "Second card")).toBeVisible();
  await expect(page.getByText("Deprecated", { exact: true })).toHaveCount(0);
});

test("a label is deleted from the board on the issue page, behind a confirmation", async ({ page, api, board }) => {
  const doomed = await api.createLabel(board.id, "Obsolete", "yellow");
  const other = await api.createIssue(board.section("BACKLOG").id, "Other card");
  await api.addLabel(other.id, doomed.id);
  const issue = await api.createIssue(board.section("TODO").id, "Deleting card");

  await page.goto(`/boards/${board.id}/issues/${issue.id}`);
  // Detaching a label sends it to the offer list, which is where people have
  // read "it did not go away". The offer row is therefore also where a label
  // can be deleted from the board for good.
  await expect(offered(page, "Obsolete")).toBeVisible();

  // The trash icon only asks. Backing out changes nothing.
  await page.getByRole("button", { name: "Delete Obsolete from this board" }).click();
  await expect(page.getByText("Delete “Obsolete” from this board?")).toBeVisible();
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByText("Delete “Obsolete” from this board?")).toBeHidden();
  await expect(offered(page, "Obsolete")).toBeVisible();

  await page.getByRole("button", { name: "Delete Obsolete from this board" }).click();
  await page.getByRole("button", { name: "Delete label" }).click();
  await expect(offered(page, "Obsolete")).toHaveCount(0);

  // Board-wide: the other card lost it too. A full navigation empties every
  // client cache, so what renders here is the row after the cascade.
  await page.goto(`/boards/${board.id}`);
  await expect(card(page, "Other card")).toBeVisible();
  await expect(page.getByText("Obsolete", { exact: true })).toHaveCount(0);
});

test("each priority prints its own mark on the card", async ({ page, api, board }) => {
  for (const [priority, mark] of Object.entries(PRIORITY_MARK)) {
    const issue = await api.createIssue(board.section("TODO").id, `${mark.title} card`);
    await api.updateIssue(issue.id, { priority });
  }

  await page.goto(`/boards/${board.id}`);

  const seen: string[] = [];
  for (const mark of Object.values(PRIORITY_MARK)) {
    // The mark's only text is the glyph; `title` is the one place the card
    // spells out which priority it means — for someone hovering it and for
    // this assertion alike.
    const badge = card(page, `${mark.title} card`).getByTitle(mark.title, { exact: true });
    await expect(badge).toHaveText(mark.glyph);
    const ink = await inkOf(badge);
    expect(ink).toBe(rgb(mark.color));
    seen.push(`${mark.glyph} ${ink}`);
  }
  // Glyph and ink together are what tell the four apart at a glance; two
  // priorities sharing both would read as one.
  expect(new Set(seen).size).toBe(Object.keys(PRIORITY_MARK).length);
});

test("picking a priority marks the card and picking it again clears it", async ({ page, api, board }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Toggle card");
  const issuePath = `/boards/${board.id}/issues/${issue.id}`;
  // The button's label is glyph + word with no separator between them, so
  // match on the word.
  const high = page.getByRole("button", { name: /High/ });

  await page.goto(issuePath);
  // Nothing on this page changes in a way a locator can see when the save
  // lands — the chosen button only changes colour — and navigating on the
  // click alone would abandon the request mid-flight. So wait for the write
  // itself rather than guess at a duration.
  const saved = () =>
    page.waitForResponse((r) => r.url().endsWith(`/issue/${issue.id}`) && r.request().method() === "PUT");

  await Promise.all([saved(), high.click()]);
  await page.goto(`/boards/${board.id}`);
  await expect(card(page, "Toggle card").getByTitle("High priority", { exact: true })).toBeVisible();

  // The buttons toggle: clicking the current priority sends null. That is the
  // only way to clear one — there is no separate "none" control.
  await page.goto(issuePath);
  await Promise.all([saved(), high.click()]);

  await page.goto(`/boards/${board.id}`);
  const toggled = card(page, "Toggle card");
  await expect(toggled).toBeVisible();
  await expect(toggled.getByTitle("High priority", { exact: true })).toHaveCount(0);
});
