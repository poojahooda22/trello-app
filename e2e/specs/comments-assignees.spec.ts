import { API_URL } from "../env";
import { expect, test, type ApiClient } from "../fixtures";

/**
 * Comments and assignees — where a card stops being a title and becomes a
 * conversation between two people.
 *
 * Why so much of this goes over HTTP: the issue page renders comments and
 * offers a box to add one, but it has no edit or delete affordance anywhere —
 * `Comments` in routes/boards/$boardId_.issues.$issueId.tsx imports `addComment`
 * and nothing else. PUT /comment/:id and DELETE /comment/:id are real endpoints
 * with real ownership rules, so those are driven over the API and the page is
 * used as the surface that has to agree with them afterwards. Posting, showing
 * an author, and unassigning are all clicked, because all three have UI.
 *
 * The only <article> in the whole app is a comment, which makes
 * getByRole("article") the honest locator for "one comment".
 */

/** The row /organization/:orgId/members actually returns. */
type MemberRow = { id: string; role: "ADMIN" | "MEMBER"; user: { id: string; email: string } };

/** PUT /comment/:commentId — not on ApiClient, and not reachable from the UI. */
function editComment(api: ApiClient, commentId: string, content: string) {
  const { request, headers } = api.raw();
  return request.put(`${API_URL}/comment/${commentId}`, { headers, data: { content } });
}

/** DELETE /comment/:commentId — likewise API-only. */
function deleteComment(api: ApiClient, commentId: string) {
  const { request, headers } = api.raw();
  return request.delete(`${API_URL}/comment/${commentId}`, { headers });
}

/** POST /issue/:issueId/assignee. Seeding, so the spec can spend its clicks on removal. */
async function assign(api: ApiClient, issueId: string, userId: string) {
  const { request, headers } = api.raw();
  const res = await request.post(`${API_URL}/issue/${issueId}/assignee`, { headers, data: { userId } });
  if (!res.ok()) throw new Error(`assign failed: ${res.status()} ${await res.text()}`);
}

const issuePath = (boardId: string, issueId: string) => `/boards/${boardId}/issues/${issueId}`;

test("a comment posted through the UI appears under the card with its author", async ({ page, api, board, user }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Checkout flow");
  await page.goto(issuePath(board.id, issue.id));

  // The heading (the title) and the key line prove we are on the right card before
  // anything is typed — "Zepto Board" gives keyPrefix ZEP and this is its first issue.
  await expect(page.getByRole("heading", { name: "Checkout flow", level: 1 })).toBeVisible();
  await expect(page.getByText("ZEP-1 · Zepto Board · To Do")).toBeVisible();
  await expect(page.getByText("No comments yet.")).toBeVisible();

  const box = page.getByPlaceholder("Add a comment");
  await box.fill("Blocked on the payment provider sandbox.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();

  const posted = page.getByRole("article").filter({ hasText: "Blocked on the payment provider sandbox." });
  await expect(posted).toBeVisible();
  // The page prints "<email> · <date>" next to an avatar whose initials are
  // email.slice(0, 2) — "E2" for every fixture user — so the address is the only
  // part of the byline that names anybody. This test has one person in the org,
  // so it can only show the byline is *present*; that it tracks the comment's
  // author rather than whoever is signed in is pinned in the moderation test.
  await expect(posted.getByText(user.email)).toBeVisible();

  // An emptied box means the mutation's onSuccess ran, not just an optimistic
  // paint — the count in the heading comes from the same refreshed cache.
  await expect(box).toHaveValue("");
  await expect(page.getByRole("heading", { name: "Comments (1)" })).toBeVisible();
});

test("editing your own comment changes what the card shows", async ({ page, api, board }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Checkout flow");
  const comment = await api.addComment(issue.id, "Sizing this at two days.");

  await page.goto(issuePath(board.id, issue.id));
  // Assert the "before" so the "after" cannot pass on a page that never rendered.
  await expect(page.getByRole("article").filter({ hasText: "Sizing this at two days." })).toBeVisible();

  const res = await editComment(api, comment.id, "Sizing this at five days, the sandbox is slower than we thought.");
  expect(res.status()).toBe(200);

  await page.reload();
  await expect(page.getByRole("article").filter({ hasText: "five days" })).toBeVisible();
  await expect(page.getByText("Sizing this at two days.")).toHaveCount(0);
  // Edited, not duplicated.
  await expect(page.getByRole("article")).toHaveCount(1);
});

test("deleting your own comment takes it off the card", async ({ page, api, board }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Checkout flow");
  const doomed = await api.addComment(issue.id, "Ignore this, wrong card.");
  await api.addComment(issue.id, "The sandbox keys landed this morning.");

  await page.goto(issuePath(board.id, issue.id));
  await expect(page.getByRole("article")).toHaveCount(2);

  const res = await deleteComment(api, doomed.id);
  expect(res.status()).toBe(204);

  await page.reload();
  // Wait on the survivor first: a bare absence assertion would also pass against
  // a page that has not finished loading its comments.
  await expect(page.getByRole("article").filter({ hasText: "The sandbox keys landed" })).toBeVisible();
  await expect(page.getByText("Ignore this, wrong card.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Comments (1)" })).toBeVisible();
});

test("a teammate cannot edit someone else's comment", async ({ page, api, board, teammate }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Checkout flow");
  const mine = await api.addComment(issue.id, "I will take this one.");

  const res = await editComment(teammate.api, mine.id, "Actually I will take this one.");
  // 403, not 404: the teammate is a member of the workspace and may read the
  // comment, so hiding its existence would be a lie. Editing is author-only —
  // the backend checks ownership and never consults role, so not even an admin
  // gets through this branch.
  expect(res.status()).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe("You can only edit your own comments");

  await page.goto(issuePath(board.id, issue.id));
  await expect(page.getByRole("article").filter({ hasText: "I will take this one." })).toBeVisible();
  await expect(page.getByText("Actually I will take this one.")).toHaveCount(0);
});

test("deleting a comment is author-or-admin: the member is refused, the owner moderates", async ({
  page,
  api,
  board,
  user,
  teammate,
}) => {
  const issue = await api.createIssue(board.section("TODO").id, "Checkout flow");
  const mine = await api.addComment(issue.id, "Owner note: shipping Thursday.");
  const theirs = await teammate.api.addComment(issue.id, "Member note: the sandbox is down again.");

  // Read the thread BEFORE moderating it. This is the only place in the suite
  // where the page shows a comment its reader did not write, so it is the only
  // place that can tell "the byline is the comment's author" apart from "the
  // byline is whoever is signed in" — every other comment here is authored by
  // the person viewing it, and a page printing the viewer's own address would
  // look identical. It also earns the absence assertion at the end: the
  // teammate's comment is proven on screen first, so its disappearance is the
  // delete working rather than the page never having rendered it.
  await page.goto(issuePath(board.id, issue.id));
  const ours = page.getByRole("article").filter({ hasText: "Owner note: shipping Thursday." });
  const theirsOnPage = page.getByRole("article").filter({ hasText: "Member note: the sandbox is down again." });
  await expect(page.getByRole("heading", { name: "Comments (2)" })).toBeVisible();
  await expect(ours.getByText(user.email)).toBeVisible();
  await expect(theirsOnPage.getByText(teammate.user.email)).toBeVisible();

  // The teammate joined by invitation, so their role is MEMBER — not the author
  // and not an admin, which is the only combination the endpoint refuses.
  const refused = await deleteComment(teammate.api, mine.id);
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toBe("You can only delete your own comments");

  // The same call from the org's creator succeeds on a comment they did not
  // write: DELETE lets an ADMIN moderate anyone, which is exactly where it
  // parts company with PUT above.
  const moderated = await deleteComment(api, theirs.id);
  expect(moderated.status()).toBe(204);

  await page.reload();
  await expect(ours).toBeVisible();
  await expect(theirsOnPage).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Comments (1)" })).toBeVisible();
});

test("an assigned teammate shows on the card, and unassigning them through the UI clears it", async ({
  page,
  api,
  board,
  teammate,
}) => {
  const issue = await api.createIssue(board.section("TODO").id, "Checkout flow");
  await assign(api, issue.id, teammate.user.id);

  await page.goto(issuePath(board.id, issue.id));
  await expect(page.getByText(teammate.user.email)).toBeVisible();
  await expect(page.getByText("Nobody yet.")).toHaveCount(0);

  // aria-label on the little x, so this reads the same to a screen reader as it
  // does here: `Unassign <email>`.
  await page.getByRole("button", { name: `Unassign ${teammate.user.email}` }).click();

  await expect(page.getByText("Nobody yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: `Unassign ${teammate.user.email}` })).toHaveCount(0);
});

test("a card on the board carries an avatar for each of its assignees", async ({ page, api, board, user, teammate }) => {
  const issue = await api.createIssue(board.section("TODO").id, "Two-person job");
  await assign(api, issue.id, user.id);
  await assign(api, issue.id, teammate.user.id);

  await page.goto(`/boards/${board.id}`);

  // The card is a <li role="button"> — it opens the issue on click, so that is
  // its real role, not a decorative list item.
  const card = page.getByRole("button").filter({ hasText: "Two-person job" });
  await expect(card).toBeVisible();
  // Every fixture email starts "e2e-", so every avatar reads "E2" — the title
  // attribute is the only thing on the card that tells the two people apart,
  // and it is what a hover has to show anyway.
  await expect(card.getByTitle(user.email)).toBeVisible();
  await expect(card.getByTitle(teammate.user.email)).toBeVisible();
});

test("the workspace lists both its owner and the teammate they invited", async ({ api, org, user, teammate }) => {
  const { request, headers } = api.raw();
  const res = await request.get(`${API_URL}/organization/${org.id}/members`, { headers });
  expect(res.status()).toBe(200);

  const members = (await res.json()) as MemberRow[];
  const byEmail = new Map(members.map((m) => [m.user.email, m]));
  expect([...byEmail.keys()].sort()).toEqual([user.email, teammate.user.email].sort());

  // Creating an organization nests an ADMIN membership for its creator; an
  // invite defaults to MEMBER. That split is the whole reason the delete-vs-edit
  // asymmetry above lands the way it does.
  expect(byEmail.get(user.email)?.role).toBe("ADMIN");
  expect(byEmail.get(teammate.user.email)?.role).toBe("MEMBER");

  // A row's own `id` is the membership, not the person. `user.id` is what
  // POST /issue/:issueId/assignee wants, and confusing the two is a 400.
  expect(byEmail.get(user.email)?.user.id).toBe(user.id);
  expect(byEmail.get(teammate.user.email)?.user.id).toBe(teammate.user.id);
});
