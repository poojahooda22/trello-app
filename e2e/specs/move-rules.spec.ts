import { readFileSync } from "node:fs";
import path from "node:path";

import type { Locator, Page } from "@playwright/test";

import { API_URL } from "../env";
import { test, expect, type Issue, type SectionKind } from "../fixtures";

/**
 * The move rules — the one piece of board logic that exists twice.
 *
 * apps/backend/board-rules.ts is the enforcer: PUT /issue/move consults it and
 * answers 409 when a card is asked to go somewhere the table forbids.
 * apps/frontend/src/lib/board.ts declares the same table so a column can refuse
 * a drop before the pointer is released, and so a card in a terminal column is
 * never draggable at all. Two copies of one rule is a mirror contract, and the
 * failure it produces is nasty: a board that invites a drop the server then
 * rejects, or one that locks a move the server would have accepted.
 *
 * So the rule is worked from three sides here — the API that enforces it, the
 * board the user actually feels it through, and the two source files read as
 * text, so a divergence fails in this file rather than under someone's pointer.
 */

/**
 * The table, written out a third time deliberately.
 *
 * The two source copies matching each other proves only that they did not
 * drift apart — not that they are still the table the product wants. This
 * literal is the contract of record, so a coordinated edit to both files also
 * turns this file red and has to be argued for rather than slipped in.
 *
 * Read it and note what it does NOT forbid: every non-Done column allows all
 * four others. The single rule the table encodes is "nothing leaves Done",
 * which is why the negative coverage below is one test and still exhaustive.
 */
const ALLOWED: Record<SectionKind, SectionKind[]> = {
  BACKLOG: ["TODO", "INPROGRESS", "REVIEW", "DONE"],
  TODO: ["BACKLOG", "INPROGRESS", "REVIEW", "DONE"],
  INPROGRESS: ["REVIEW", "BACKLOG", "DONE", "TODO"],
  REVIEW: ["INPROGRESS", "DONE", "BACKLOG", "TODO"],
  DONE: [],
};

const KINDS = Object.keys(ALLOWED) as SectionKind[];

// ---------------------------------------------------------------------------
// The mirror contract
// ---------------------------------------------------------------------------

/** Rows compared as sets: canMove asks them with .includes(), so the order
 *  inside a row means nothing and a reshuffle must not read as drift. */
function asSets(table: Record<string, readonly string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(table).map(([kind, targets]) => [kind, [...targets].sort()]));
}

/**
 * Lifts the ALLOWED literal out of a source file as data.
 *
 * Importing the two modules would be neater, but only one of them would load:
 * board-rules.ts is dependency-free, while the frontend copy pulls its type
 * through the "@/" alias that only the bundler resolves. Reading both as text
 * compares like with like — and it is the stricter check anyway, because it
 * sees the file a reviewer sees rather than whatever a loader made of it.
 */
function allowedTableIn(repoRelativePath: string): Record<string, string[]> {
  // testInfo.file is absolute and loader-agnostic, which __dirname and cwd are
  // not; this spec sits in e2e/specs, so the repo root is two levels up.
  const file = path.resolve(path.dirname(test.info().file), "../..", repoRelativePath);
  const source = readFileSync(file, "utf8");

  const literal = source.match(/export const ALLOWED[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!literal) throw new Error(`no "export const ALLOWED = { … };" table found in ${repoRelativePath}`);

  const table: Record<string, string[]> = {};
  for (const line of literal[1]!.split("\n")) {
    const row = line.match(/^\s*([A-Z]+)\s*:\s*\[([^\]]*)\]/);
    if (row) table[row[1]!] = [...row[2]!.matchAll(/"([A-Z]+)"/g)].map((m) => m[1]!).sort();
  }
  return table;
}

test("the backend and the frontend declare the same transition table", async () => {
  const backend = allowedTableIn("apps/backend/board-rules.ts");
  const frontend = allowedTableIn("apps/frontend/src/lib/board.ts");

  // Check the parser before trusting its verdict. Two empty objects are equal
  // to each other, so a regex that quietly stopped matching would leave this
  // test incapable of failing — the worst outcome available to it.
  expect(Object.keys(backend).sort(), "parsed no rows out of apps/backend/board-rules.ts").toEqual([...KINDS].sort());
  expect(Object.keys(frontend).sort(), "parsed no rows out of apps/frontend/src/lib/board.ts").toEqual(
    [...KINDS].sort(),
  );

  expect(frontend, "apps/frontend/src/lib/board.ts has drifted from apps/backend/board-rules.ts").toEqual(backend);
  expect(backend, "the transition table changed — update ALLOWED at the top of this spec with it").toEqual(
    asSets(ALLOWED),
  );
});

// ---------------------------------------------------------------------------
// The rule as the API enforces it
// ---------------------------------------------------------------------------

test("every transition the table allows is accepted", async ({ api, board }) => {
  for (const from of KINDS) {
    for (const to of ALLOWED[from]) {
      // A fresh card per transition: a move mutates the card, so reusing one
      // would make every assertion depend on the previous one having landed.
      const card = await api.createIssue(board.section(from).id, `${from} to ${to}`);
      const res = await api.moveIssue(card.id, board.section(to).id);

      expect(res.status(), `${from} → ${to} is in the table and must be accepted`).toBe(200);
      const moved = (await res.json()) as Issue;
      expect(moved.sectionId).toBe(board.section(to).id);
      // Every write bumps the version, and open tabs drop socket events older
      // than what they already hold — a move that did not bump it would be
      // discarded by every other browser on the board.
      expect(moved.version).toBeGreaterThan(card.version);
    }
  }
});

test("Done is terminal: nothing leaves it, and the refused card does not budge", async ({ api, board }) => {
  const done = board.section("DONE");
  // Done's row is empty and every other row is complete, so these four are the
  // entire set of moves the table forbids.
  const forbidden = KINDS.filter((kind) => kind !== "DONE");

  for (const to of forbidden) {
    const card = await api.createIssue(done.id, `Sealed, aimed at ${to}`);
    const res = await api.moveIssue(card.id, board.section(to).id);

    expect(res.status(), `DONE → ${to} is not in the table and must be refused`).toBe(409);
    // The message names both columns by their titles because the board renders
    // it verbatim above the columns. Asserting on it keeps that copy honest.
    expect(await res.json()).toEqual({ error: `Cannot move a card from Done to ${board.section(to).title}` });
  }

  // A 409 is only half the contract; the other half is that no write happened.
  // Ask the board where those four cards actually are.
  const { sections } = await api.getSections(board.id);
  for (const section of sections) {
    const expected = section.kind === "DONE" ? forbidden.length : 0;
    expect(section.issues, `${section.title} should hold ${expected} cards`).toHaveLength(expected);
  }
});

test("a move inside one column is a reorder, not a transition", async ({ api, board }) => {
  const todo = board.section("TODO");
  await api.createIssue(todo.id, "First");
  await api.createIssue(todo.id, "Second");
  const third = await api.createIssue(todo.id, "Third");

  // New cards are appended a POSITION_GAP (1000) apart, so 500 means "ahead of
  // everything" without having to renumber the cards that stay put.
  const res = await api.moveIssue(third.id, todo.id, 500);
  expect(res.status()).toBe(200);
  expect(((await res.json()) as Issue).position).toBe(500);

  const { sections } = await api.getSections(board.id);
  const order = sections.find((s) => s.id === todo.id)!.issues.map((i) => i.title);
  expect(order).toEqual(["Third", "First", "Second"]);
});

test("Done still reorders, even though its row in the table is empty", async ({ api, board }) => {
  const done = board.section("DONE");
  await api.createIssue(done.id, "Shipped Monday");
  const second = await api.createIssue(done.id, "Shipped Tuesday");

  // canMove short-circuits on from === to before it ever consults ALLOWED, and
  // that is what stops an empty row from freezing the column's own ordering.
  // Worth pinning, because "Done accepts nothing" is the obvious misreading.
  const res = await api.moveIssue(second.id, done.id, 1);
  expect(res.status(), "a card may be reordered within Done").toBe(200);

  const { sections } = await api.getSections(board.id);
  const order = sections.find((s) => s.id === done.id)!.issues.map((i) => i.title);
  expect(order).toEqual(["Shipped Tuesday", "Shipped Monday"]);
});

test("a custom column takes a card of any kind and hands it back", async ({ api, board }) => {
  // The fixtures expose only the five default columns, so this one is made
  // through the raw client. A column created this way has no kind, which is
  // the whole point: canMove treats a null kind as unconstrained on both sides.
  const { request, headers } = api.raw();
  const created = await request.post(`${API_URL}/section`, { headers, data: { boardId: board.id, title: "Blocked" } });
  expect(created.status()).toBe(201);
  const custom = (await created.json()) as { id: string; title: string; kind: SectionKind | null };
  expect(custom.kind, "a column made through POST /section must have no kind").toBeNull();

  const parked: Issue[] = [];
  for (const kind of KINDS) {
    const card = await api.createIssue(board.section(kind).id, `${kind} card`);
    const inbound = await api.moveIssue(card.id, custom.id);
    expect(inbound.status(), `${kind} → a custom column must be accepted`).toBe(200);
    parked.push(card);
  }

  for (const card of parked) {
    const outbound = await api.moveIssue(card.id, board.section("TODO").id);
    expect(outbound.status(), `a custom column must release ${card.title}`).toBe(200);
  }

  const { sections } = await api.getSections(board.id);
  expect(sections.find((s) => s.id === custom.id)!.issues).toHaveLength(0);
  expect(sections.find((s) => s.kind === "TODO")!.issues).toHaveLength(KINDS.length);

  // Read that last assertion twice: the card that started in Done is now in To
  // Do, a move the table refuses outright. A custom column is a real escape
  // hatch out of Done, in two hops. It falls straight out of canMove's null
  // check rather than being an oversight, and it is asserted here so that
  // closing the hatch has to be a decision instead of a surprise.
  const doneOrigin = parked.find((card) => card.title === "DONE card")!;
  const landed = sections.find((s) => s.issues.some((i) => i.id === doneOrigin.id));
  expect(landed?.kind).toBe("TODO");
});

test("a card cannot be moved into another board's column", async ({ api, org, board }) => {
  const elsewhere = await api.createBoard(org.id, "Neighbouring Board");
  const { sections } = await api.getSections(elsewhere.id);
  const card = await api.createIssue(board.section("TODO").id, "Stays home");

  // TODO → TODO sails through the transition table, so this proves the board
  // check is a guard of its own rather than something the kind comparison
  // happens to catch on the way past.
  const res = await api.moveIssue(card.id, sections.find((s) => s.kind === "TODO")!.id);
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: "Cannot move an issue to another board" });
});

// ---------------------------------------------------------------------------
// The rule as the board applies it
// ---------------------------------------------------------------------------

/** A board column. The <section> carries no accessible name of its own, so it
 *  is found through the <h2> it wraps — the same handle a person uses. */
const columnNamed = (page: Page, title: string): Locator =>
  page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: title, exact: true }) });

/** A card. issue-card.tsx gives the <li> role="button", so its accessible name
 *  is its own contents: the title, then the key. */
const cardNamed = (column: Locator, title: string): Locator => column.getByRole("button", { name: title });

/**
 * Drags a card onto a column the way a hand does.
 *
 * dnd-kit's pointer sensor arms on a distance constraint — the pointer has to
 * travel more than five pixels from where it went down — and then follows the
 * operation through the pointermove events after that, resolving them a frame
 * behind. Playwright's dragTo is a single instantaneous jump, which produces
 * neither the threshold crossing nor the frames, so the drag never starts and
 * the test would pass or fail for reasons that have nothing to do with the
 * move rules. Hence the explicit steps.
 */
async function dragCardTo(
  page: Page,
  card: Locator,
  column: Locator,
  /** False for a card the board locks: no drag begins, so no column is ever armed. */
  opts: { expectDropTarget?: boolean } = {},
): Promise<void> {
  const grip = await card.boundingBox();
  const target = await column.boundingBox();
  if (!grip || !target) throw new Error("the card or the column is not laid out on screen");

  const grabbed = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  const dropped = { x: target.x + target.width / 2, y: target.y + target.height / 2 };

  await card.hover();
  await page.mouse.down();
  // Cross the five-pixel threshold on its own first, so the sensor is armed
  // before the long move rather than somewhere in the middle of it.
  await page.mouse.move(grabbed.x + 12, grabbed.y + 12, { steps: 5 });
  await page.mouse.move(dropped.x, dropped.y, { steps: 20 });
  // One more nudge on the spot: the drop target comes from the last move
  // dnd-kit processed, and it processes them a frame behind the pointer.
  await page.mouse.move(dropped.x, dropped.y + 4, { steps: 4 });

  if (opts.expectDropTarget ?? true) {
    // Then wait for the board to say so, rather than hoping the frames ran.
    // board-column.tsx:20 paints `ring-2` while useDroppable reports
    // isDropTarget, and isDropTarget is literally
    // `manager.dragOperation.target?.id === this.id` — the same value mouse.up
    // reads to decide where the card lands. So the ring is not a proxy for the
    // drop being ready; it is the drop being ready, rendered.
    await expect(column, "dnd-kit never made this column the drop target").toHaveClass(/ring-2/);
  }

  await page.mouse.up();
}

test("a card dragged into the next column lands there and the move reaches the server", async ({
  page,
  api,
  board,
}) => {
  const card = await api.createIssue(board.section("TODO").id, "Drag me forward");

  await page.goto(`/boards/${board.id}`);

  const todo = columnNamed(page, "To Do");
  const inProgress = columnNamed(page, "In Progress");
  await expect(cardNamed(todo, "Drag me forward")).toBeVisible();

  // Armed before the action: the board places the card optimistically, so the
  // DOM would look exactly like this even if the PUT were never sent. Waiting
  // on the response is what makes the assertions underneath mean anything.
  const moved = page.waitForResponse((res) => res.url().endsWith("/issue/move") && res.request().method() === "PUT");
  await dragCardTo(page, cardNamed(todo, "Drag me forward"), inProgress);
  expect((await moved).status(), "TODO → INPROGRESS is in the table").toBe(200);

  // Counting rather than toBeVisible: dnd-kit clones the card for the drag
  // preview, so the title is briefly on screen twice, and a count assertion
  // retries through that instead of tripping strict mode on a transient clone.
  await expect(cardNamed(inProgress, "Drag me forward")).toHaveCount(1);
  await expect(cardNamed(todo, "Drag me forward")).toHaveCount(0);

  const { sections } = await api.getSections(board.id);
  expect(sections.find((s) => s.issues.some((i) => i.id === card.id))?.kind).toBe("INPROGRESS");
});

test("the board will not drag a card out of Done at all", async ({ page, api, board }) => {
  await api.createIssue(board.section("BACKLOG").id, "Control card");
  const sealed = await api.createIssue(board.section("DONE").id, "Sealed card");

  await page.goto(`/boards/${board.id}`);

  const backlog = columnNamed(page, "Backlog");
  const todo = columnNamed(page, "To Do");
  const done = columnNamed(page, "Done");
  await expect(cardNamed(backlog, "Control card")).toBeVisible();
  await expect(cardNamed(done, "Sealed card")).toBeVisible();

  // The control drag comes first on purpose. Without a drag known to work in
  // this browser at this moment, "the Done card did not move" is also what a
  // broken helper produces, and the real assertion below could never fail —
  // the one thing a negative test must not be.
  //
  // Filtered to PUT for the same reason as the waiter above: the app is on
  // :5273 and the API on :3101, so the browser sends a CORS preflight to this
  // very URL first. Playwright reports it like any other request, and its 204
  // is what an unfiltered waiter would resolve on.
  const control = page.waitForResponse((res) => res.url().endsWith("/issue/move") && res.request().method() === "PUT");
  await dragCardTo(page, cardNamed(backlog, "Control card"), todo);
  expect((await control).status()).toBe(200);
  await expect(cardNamed(todo, "Control card")).toHaveCount(1);

  // Now the card the frontend's copy of the table locks. issue-card.tsx
  // disables the draggable outright when a column's row is empty, so this is
  // not a request the backend gets to refuse — it is a request that is never
  // made, which is the entire reason the frontend keeps a copy of the table.
  //
  // Every request counts here, the preflight included: an unlocked card would
  // send an OPTIONS as well as a PUT, and either is proof the page tried. The
  // method is recorded so a failure names what was sent rather than a bare URL.
  const moveRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/issue/move")) moveRequests.push(`${req.method()} ${req.url()}`);
  });

  await dragCardTo(page, cardNamed(done, "Sealed card"), todo, { expectDropTarget: false });

  // A real round trip before judging the request log: anything the page meant
  // to send has had its chance by the time the server has answered this.
  const { sections } = await api.getSections(board.id);
  expect(sections.find((s) => s.issues.some((i) => i.id === sealed.id))?.kind).toBe("DONE");
  expect(moveRequests, "a locked card must not even ask the server").toHaveLength(0);

  await expect(cardNamed(done, "Sealed card")).toHaveCount(1);
  await expect(cardNamed(todo, "Sealed card")).toHaveCount(0);
  // And no banner: refusing to lift a locked card is a no-op, not an error.
  await expect(page.getByText("Cannot move a card")).toHaveCount(0);
});
