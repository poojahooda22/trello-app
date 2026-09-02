import { test, expect } from "../fixtures";

/**
 * Proves the harness itself: all three services up, the browser talking to the
 * E2E backend rather than the development one, and the fixtures producing a
 * signed-in session on a real board.
 *
 * When the rest of the suite fails at once, run this first — if it is red the
 * problem is the stack or the database, not the feature under test.
 */

test("the app serves an unauthenticated visitor the signup screen", async ({ browser }) => {
  // A context of its own: the `page` fixture arrives already signed in, and
  // this is the one assertion that needs a visitor who is not.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");

  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole("heading", { name: "Sign up to continue" })).toBeVisible();
  await context.close();
});

test("a signed-in user lands on their board with the five default columns", async ({ page, board }) => {
  await page.goto(`/boards/${board.id}`);

  for (const title of ["Backlog", "To Do", "In Progress", "Review", "Done"]) {
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  }
});

test("the browser talks to the E2E backend, not the development stack", async ({ page, board }) => {
  const calls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/sections")) calls.push(req.url());
  });

  await page.goto(`/boards/${board.id}`);
  await expect(page.getByText("Backlog", { exact: true }).first()).toBeVisible();

  expect(calls.length).toBeGreaterThan(0);
  // 3101 is the E2E API. 3001 would mean the bundle was built with the
  // developer's .env and every write is landing in Neon.
  expect(calls.every((url) => url.includes(":3101"))).toBe(true);
});

test("a card created over the API shows up on the board", async ({ page, api, board }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Harness check card");

  await page.goto(`/boards/${board.id}`);

  await expect(page.getByText("Harness check card")).toBeVisible();
  // keyPrefixFor("Zepto Board") === "ZEP", and this is the board's first card.
  expect(issue.key).toBe("ZEP-1");
});
