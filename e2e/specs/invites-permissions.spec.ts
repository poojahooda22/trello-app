import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse, Browser } from "@playwright/test";

import { API_URL, BASE_URL } from "../env";
import { ApiClient, authenticate, expect, signUp, test, type TestUser } from "../fixtures";

/**
 * Invites, membership and permissions.
 *
 * One rule sits under the whole file: access is a row in Member, and that row
 * is scoped to the ORGANIZATION, never to a board. A single accepted invite
 * opens every board in the workspace — including boards that did not exist when
 * it was accepted — and deleting the row closes all of them at once.
 *
 * Statuses are asserted exactly, because the numbers carry the meaning here.
 * requireMember() answers a non-member with 404 rather than 403 on purpose: a
 * 403 would confirm the uuid names a real organization and leak the shape of
 * workspaces the caller is not in. A member who lacks ADMIN gets 403 instead —
 * they already know the workspace exists, so there is nothing left to hide.
 */

/** The headers the app's own fetch wrapper sends. Used wherever a spec asserts on
 *  a status that ApiClient would otherwise turn into a thrown setup error. */
function as(who: TestUser) {
  return { Authorization: `Bearer ${who.token}`, "Content-Type": "application/json" };
}

/** An address nobody has signed up with — for invites that must fail before anyone redeems them. */
function unusedEmail() {
  return `e2e-invitee-${randomUUID()}@example.test`;
}

/**
 * The accept token out of an invite response.
 *
 * RESEND_API_KEY is empty in the E2E env (playwright.config.ts), so /invite
 * returns the link instead of mailing it. That is the behaviour under test, not
 * a workaround: it is what a deployment with no mail provider does, and it is
 * the only reason the `teammate` fixture can exist at all.
 */
async function inviteToken(res: APIResponse): Promise<string> {
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.emailed).toBe(false);
  expect(body.link, "invite carried no link — is RESEND_API_KEY set in the E2E env?").toBeTruthy();
  const token = new URL(body.link).searchParams.get("token");
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  return token as string;
}

function accept(request: APIRequestContext, token: string, who: TestUser) {
  return request.post(`${API_URL}/accept`, { headers: as(who), data: { token } });
}

/** A second browser, signed in as somebody other than the `page` fixture's user. */
async function pageAs(browser: Browser, who: TestUser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await authenticate(page, who.token);
  return { context, page };
}

// --- The invite itself -------------------------------------------------------

test("an invite comes back as a usable link when no mail provider is configured", async ({ anon, api, org }) => {
  const invitee = await signUp(anon);

  const res = await api.invite(org.id, invitee.email);
  expect(res.status()).toBe(201);
  const body = await res.json();

  expect(body).toMatchObject({ email: invitee.email, role: "MEMBER", emailed: false });

  // INVITE_TTL_MS is seven days. Asserted as a window rather than an instant so
  // the test is not racing the clock it is measuring.
  const ttl = new Date(body.expiresAt).getTime() - Date.now();
  expect(ttl).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
  expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);

  // The link points back at this app and carries the 32 random bytes that are
  // the only secret protecting /accept.
  expect(body.link.startsWith(`${BASE_URL}/accept-invite?token=`)).toBe(true);
  const token = new URL(body.link).searchParams.get("token") as string;
  expect(token).toMatch(/^[0-9a-f]{64}$/);

  // A link is only worth something if it admits somebody, so redeem it.
  const accepted = await accept(anon, token, invitee);
  expect(accepted.status()).toBe(201);
  expect(await accepted.json()).toMatchObject({ orgId: org.id, role: "MEMBER" });
});

test("one accepted invite opens every board in the workspace, including later ones", async ({
  anon,
  api,
  board,
  org,
}) => {
  // `board` is the fixture's "Zepto Board". It is requested explicitly because
  // Playwright only builds the fixtures a test names, and this spec asserts on
  // the whole board list of the workspace, not just the one it creates here.
  const ledger = await api.createBoard(org.id, "Ledger Board");
  const invitee = await signUp(anon);

  const token = await inviteToken(await api.invite(org.id, invitee.email));
  expect((await accept(anon, token, invitee)).status()).toBe(201);

  const theirs = new ApiClient(anon, invitee.token);

  // The invite named no board, and both of the workspace's boards are theirs to
  // read — the org-scoped-not-board-scoped claim, asserted directly.
  const listed = await anon.get(`${API_URL}/boards?orgId=${org.id}`, { headers: as(invitee) });
  expect(listed.status()).toBe(200);
  const titles = ((await listed.json()) as { title: string }[]).map((b) => b.title).sort();
  expect(titles).toEqual([ledger.title, board.title].sort());

  const { sections } = await theirs.getSections(ledger.id);
  expect(sections.map((s) => s.title)).toEqual(["Backlog", "To Do", "In Progress", "Review", "Done"]);

  // A board created after acceptance is not a special case: access is a live
  // Member row, not a snapshot of the boards taken at accept time.
  const later = await api.createBoard(org.id, "Payments Board");
  const afterwards = await theirs.getSections(later.id);
  expect(afterwards.sections).toHaveLength(5);
});

test("an invite token is single use, and a token nobody issued is worth nothing", async ({ anon, api, org }) => {
  const invitee = await signUp(anon);
  const token = await inviteToken(await api.invite(org.id, invitee.email));

  expect((await accept(anon, token, invitee)).status()).toBe(201);

  // acceptedAt is claimed by a guarded updateMany inside the same transaction
  // that creates the Member row, so replaying the link cannot mint a second
  // membership.
  const replay = await accept(anon, token, invitee);
  expect(replay.status()).toBe(409);
  expect(await replay.json()).toEqual({ error: "That invitation has already been used" });

  const members = await anon.get(`${API_URL}/organization/${org.id}/members`, { headers: as(invitee) });
  expect(members.status()).toBe(200);
  // The owner and the invitee, once each. A second row here would be the bug
  // that the 409 above is only the symptom of.
  expect((await members.json()) as unknown[]).toHaveLength(2);

  const forged = await accept(anon, "0".repeat(64), invitee);
  expect(forged.status()).toBe(404);
  expect(await forged.json()).toEqual({ error: "Invitation not found" });
});

test("an invite is bound to the address it was issued to", async ({ anon, api, org }) => {
  const invitee = await signUp(anon);
  const stranger = await signUp(anon);
  const token = await inviteToken(await api.invite(org.id, invitee.email));

  // Forwarding the link does not forward the invitation with it.
  const forwarded = await accept(anon, token, stranger);
  expect(forwarded.status()).toBe(403);
  expect(await forwarded.json()).toEqual({
    error: "This invitation was issued to a different email address",
  });

  // And the refusal did not burn the invite: the address check runs before the
  // claim, so the person it was meant for can still redeem it.
  expect((await accept(anon, token, invitee)).status()).toBe(201);
});

// --- Who is kept out ---------------------------------------------------------

test("a non-member is refused with 404, never 403", async ({ anon, org, board }) => {
  const outsider = await signUp(anon);
  const headers = as(outsider);

  // No token at all is a different failure with a different meaning: the caller
  // has not said who they are yet.
  const anonymous = await anon.get(`${API_URL}/sections?boardId=${board.id}`);
  expect(anonymous.status()).toBe(401);
  expect(await anonymous.json()).toEqual({ error: "Missing Bearer token" });

  // A real account that simply is not in this organization. 404 and a bare
  // "Not found": anything more specific would confirm the id exists.
  const sections = await anon.get(`${API_URL}/sections?boardId=${board.id}`, { headers });
  expect(sections.status()).toBe(404);
  expect(await sections.json()).toEqual({ error: "Not found" });

  expect((await anon.get(`${API_URL}/boards?orgId=${org.id}`, { headers })).status()).toBe(404);
  expect((await anon.get(`${API_URL}/organization/${org.id}/members`, { headers })).status()).toBe(404);
  expect(
    (
      await anon.post(`${API_URL}/issue`, {
        headers,
        data: { sectionId: board.section("TODO").id, title: "Not yours" },
      })
    ).status(),
  ).toBe(404);
  // Even the admin-only route answers 404 rather than 403 to an outsider:
  // membership is checked before the role is.
  expect(
    (await anon.post(`${API_URL}/invite`, { headers, data: { orgId: org.id, email: unusedEmail() } })).status(),
  ).toBe(404);

  // And the workspace never appears in their own list.
  expect(await (await anon.get(`${API_URL}/organization`, { headers })).json()).toEqual([]);
});

test("a non-member who opens the board URL gets the error, not the board", async ({ anon, browser, board }) => {
  const outsider = await signUp(anon);
  const { context, page } = await pageAs(browser, outsider);

  await page.goto(`/boards/${board.id}`);

  // React Query's default retry is three attempts backing off 1s + 2s + 4s
  // before a failed query reaches its error state, which outlasts the 10s
  // default for expect. The wait belongs to the query, not to this spec.
  await expect(page.getByText("Not found")).toBeVisible({ timeout: 20_000 });
  // Nothing of the board leaked while that resolved.
  await expect(page.getByText("Backlog", { exact: true })).toHaveCount(0);
  // The invite trigger hangs off `workspace`, which only resolves for members.
  await expect(page.getByRole("button", { name: "Invite someone" })).toHaveCount(0);

  await context.close();
});

// --- ADMIN versus MEMBER -----------------------------------------------------

test("a MEMBER runs the boards but cannot administer the workspace", async ({ anon, user, org, board, teammate }) => {
  const headers = as(teammate.user);

  // The everyday work is open to any member.
  const theirBoard = await teammate.api.createBoard(org.id, "Teammate Board");
  expect(theirBoard.organizationId).toBe(org.id);

  const renamed = await anon.put(`${API_URL}/board/${board.id}`, {
    headers,
    data: { title: "Renamed by a member" },
  });
  expect(renamed.status()).toBe(200);

  const members = await anon.get(`${API_URL}/organization/${org.id}/members`, { headers });
  expect(members.status()).toBe(200);
  const emails = ((await members.json()) as { user: { email: string } }[]).map((m) => m.user.email).sort();
  expect(emails).toEqual([user.email, teammate.user.email].sort());

  // Administration is not. Each of these is 403 rather than 404 — the member
  // can see the workspace, so the only thing being withheld is the role.
  const invited = await teammate.api.invite(org.id, unusedEmail());
  expect(invited.status()).toBe(403);
  expect(await invited.json()).toEqual({ error: "Admin role required" });

  expect((await anon.delete(`${API_URL}/board/${board.id}`, { headers })).status()).toBe(403);
  expect((await anon.delete(`${API_URL}/organization/${org.id}`, { headers })).status()).toBe(403);
  // Removing somebody else included, or the workspace would be one API call
  // away from a member evicting its owner.
  const eviction = await anon.delete(`${API_URL}/membership`, {
    headers,
    data: { userId: user.id, orgId: org.id },
  });
  expect(eviction.status()).toBe(403);
  expect(await eviction.json()).toEqual({ error: "Admin role required" });

  // The refused calls changed nothing: both boards are still there, and the
  // rename a member IS allowed to make still stands.
  const still = await anon.get(`${API_URL}/boards?orgId=${org.id}`, { headers });
  expect(((await still.json()) as { title: string }[]).map((b) => b.title).sort()).toEqual([
    "Renamed by a member",
    "Teammate Board",
  ]);
});

test("an invite issued with the ADMIN role carries the admin-only powers", async ({ anon, api, org }) => {
  const promoted = await signUp(anon);
  const token = await inviteToken(await api.invite(org.id, promoted.email, "ADMIN"));

  // The role rides on the invite row, so it is settled when the invitation is
  // written rather than when it is redeemed.
  const accepted = await accept(anon, token, promoted);
  expect(accepted.status()).toBe(201);
  expect(await accepted.json()).toMatchObject({ orgId: org.id, role: "ADMIN" });

  // The two routes the MEMBER spec above is refused on.
  const theirInvite = await new ApiClient(anon, promoted.token).invite(org.id, unusedEmail());
  expect(theirInvite.status()).toBe(201);

  const disposable = await api.createBoard(org.id, "Disposable Board");
  expect((await anon.delete(`${API_URL}/board/${disposable.id}`, { headers: as(promoted) })).status()).toBe(204);
});

// --- Losing access -----------------------------------------------------------

test("removing a membership revokes the whole workspace at once", async ({
  anon,
  api,
  browser,
  user,
  org,
  board,
  teammate,
}) => {
  const headers = as(teammate.user);
  const second = await api.createBoard(org.id, "Roadmap Board");

  // Both boards read fine while the membership stands.
  expect((await anon.get(`${API_URL}/sections?boardId=${board.id}`, { headers })).status()).toBe(200);
  expect((await anon.get(`${API_URL}/sections?boardId=${second.id}`, { headers })).status()).toBe(200);

  const removed = await anon.delete(`${API_URL}/membership`, {
    headers: as(user),
    data: { userId: teammate.user.id, orgId: org.id },
  });
  expect(removed.status()).toBe(204);

  // One row deleted, every board closed — the mirror image of one invite
  // opening every board.
  expect((await anon.get(`${API_URL}/sections?boardId=${board.id}`, { headers })).status()).toBe(404);
  expect((await anon.get(`${API_URL}/sections?boardId=${second.id}`, { headers })).status()).toBe(404);
  expect(await (await anon.get(`${API_URL}/organization`, { headers })).json()).toEqual([]);

  // And the app agrees, rather than showing a workspace whose boards would all
  // fail to load.
  const { context, page } = await pageAs(browser, teammate.user);
  await page.goto("/boards");
  // Scoped to <main>: the sidebar carries its own, shorter empty-state sentence.
  await expect(page.getByRole("main").getByText(/No workspaces yet/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Zepto Board" })).toHaveCount(0);
  await context.close();
});

test("a member may remove themselves, but the last admin may not", async ({ anon, api, user, org, teammate }) => {
  // Leaving is not an admin action — anyone may remove their own membership.
  const left = await anon.delete(`${API_URL}/membership`, {
    headers: as(teammate.user),
    data: { userId: teammate.user.id, orgId: org.id },
  });
  expect(left.status()).toBe(204);

  // The owner is now the only admin, and the guard refuses rather than leaving
  // an organization nobody can administer.
  const stranded = await anon.delete(`${API_URL}/membership`, {
    headers: as(user),
    data: { userId: user.id, orgId: org.id },
  });
  expect(stranded.status()).toBe(409);
  expect(await stranded.json()).toEqual({ error: "Cannot remove the last admin of an organization" });

  // The refused delete left the row intact — and left it ADMIN. Two separate
  // claims, so two calls: /members only needs membership, so a 200 there would
  // still be true of a demoted row. POST /invite is the admin-only route, and
  // it is the one that proves the role survived as well as the row.
  expect((await anon.get(`${API_URL}/organization/${org.id}/members`, { headers: as(user) })).status()).toBe(200);
  expect((await api.invite(org.id, unusedEmail())).status()).toBe(201);
});

// --- The dialog --------------------------------------------------------------

test("the invite dialog hands back a link that admits the person it names", async ({ anon, page, org, board }) => {
  const invitee = await signUp(anon);

  await page.goto(`/boards/${board.id}`);
  await page.getByRole("button", { name: "Invite someone" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Invite to ${org.name}` })).toBeVisible();
  // The copy is the product's promise about org-scoped membership; the API
  // tests above are what prove it true.
  await expect(dialog.getByText("They will be able to see every board in this workspace.")).toBeVisible();

  await dialog.getByLabel("Email address").fill(invitee.email);
  await dialog.getByRole("button", { name: "Send invitation" }).click();

  // No RESEND_API_KEY, so the dialog falls back to showing the link itself.
  await expect(dialog.getByText("No mail provider is configured, so send this link yourself:")).toBeVisible();
  const link = (await dialog.locator("code").textContent()) ?? "";
  expect(link.startsWith(`${BASE_URL}/accept-invite?token=`)).toBe(true);

  // Redeemed over the API rather than by navigating to it: the backend builds
  // the link from APP_URL, and the SPA has no /accept-invite route to catch it
  // yet (routeTree.gen.ts). What is under test here is that the token the
  // dialog displays is the real one — not that the page behind it exists.
  const token = new URL(link).searchParams.get("token") as string;
  const accepted = await accept(anon, token, invitee);
  expect(accepted.status()).toBe(201);
  expect(await accepted.json()).toMatchObject({ orgId: org.id, role: "MEMBER" });

  const { sections } = await new ApiClient(anon, invitee.token).getSections(board.id);
  expect(sections).toHaveLength(5);
});

test("the invite dialog shows the refusal when the address is already a member", async ({ page, board, teammate }) => {
  await page.goto(`/boards/${board.id}`);
  await page.getByRole("button", { name: "Invite someone" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email address").fill(teammate.user.email);
  await dialog.getByRole("button", { name: "Send invitation" }).click();

  // A second invite to the same person would try to create a second Member row
  // on accept. The 409 is rendered rather than swallowed, so the admin learns
  // why nothing was sent.
  await expect(dialog.getByText("That user is already a member of this organization")).toBeVisible();
  await expect(dialog.locator("code")).toHaveCount(0);
});

test("a MEMBER can open the invite dialog but the backend refuses the send", async ({ browser, board, teammate }) => {
  // The trigger renders for every member — the role is enforced only on the
  // server — so this is the one place a MEMBER meets the difference as a user.
  const { context, page } = await pageAs(browser, teammate.user);

  await page.goto(`/boards/${board.id}`);
  await page.getByRole("button", { name: "Invite someone" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email address").fill(unusedEmail());
  await dialog.getByRole("button", { name: "Send invitation" }).click();

  await expect(dialog.getByText("Admin role required")).toBeVisible();
  await expect(dialog.locator("code")).toHaveCount(0);

  await context.close();
});

test("an invitation opened under the wrong account survives switching to the right one", async ({
  page,
  anon,
  api,
  org,
}) => {
  const invitee = await signUp(anon);
  const token = await inviteToken(await api.invite(org.id, invitee.email));

  // The link is opened in a browser already signed in as the owner — the very
  // person who sent it, checking that it works. The accept is refused, and the
  // page offers the way out rather than a dead end.
  await page.goto(`/accept-invite?token=${token}`);
  await expect(page.getByText("This invitation was issued to a different email address")).toBeVisible();
  await page.getByRole("button", { name: "Use the invited address instead" }).click();
  // Signed out on the spot, and offered both doors: the invited person may
  // or may not have an account. This one does.
  await page.getByRole("button", { name: "I already have one" }).click();
  await expect(page).toHaveURL(/\/signin$/);

  await page.getByLabel("Email").fill(invitee.email);
  await page.getByLabel("Password").fill(invitee.password);
  await page.getByRole("button", { name: "Log in" }).click();

  // Signing in resumes the invitation instead of landing on the boards with
  // it dropped. The proof is the membership, not the URL: the boards page is
  // where both outcomes end up.
  await expect(page).toHaveURL(/\/boards$/);
  await expect
    .poll(async () => {
      const res = await anon.get(`${API_URL}/organization/${org.id}/members`, { headers: as(invitee) });
      return res.status();
    })
    .toBe(200);
});

test("an invited person with no account yet can create one from the wrong-account screen", async ({
  page,
  api,
  org,
}) => {
  const email = unusedEmail();
  const token = await inviteToken(await api.invite(org.id, email));

  // Opened while signed in as the owner, as before — but this invitee has
  // never signed up, so "sign in" would be a dead end for them.
  await page.goto(`/accept-invite?token=${token}`);
  await expect(page.getByText("This invitation was issued to a different email address")).toBeVisible();
  await page.getByRole("button", { name: "Use the invited address instead" }).click();
  await page.getByRole("button", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup$/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e-password-1234");
  await page.getByRole("button", { name: "Sign up" }).click();

  // Signing up resumes the parked invitation: the new account is a member.
  await expect(page).toHaveURL(/\/boards$/);
  const { request, headers } = api.raw();
  await expect
    .poll(async () => {
      const members = (await (await request.get(`${API_URL}/organization/${org.id}/members`, { headers })).json()) as {
        user: { email: string };
      }[];
      return members.some((m) => m.user.email === email);
    })
    .toBe(true);
});

test("an invitation opened under the wrong account does not capture the owner's later sign-ins", async ({
  page,
  anon,
  api,
  org,
  user,
}) => {
  const invitee = await signUp(anon);
  const token = await inviteToken(await api.invite(org.id, invitee.email));

  // The owner opens the link, is refused, and simply goes back to work.
  await page.goto(`/accept-invite?token=${token}`);
  await expect(page.getByText("This invitation was issued to a different email address")).toBeVisible();
  await page.getByRole("link", { name: "Go to your boards" }).click();
  await expect(page).toHaveURL(/\/boards$/);

  // Signing out and back in must land on the boards, not on that refusal
  // again: nothing about the invitation may linger in this browser.
  await page.evaluate(() => localStorage.removeItem("token"));
  await page.goto("/signin");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/boards$/);
  expect(await page.evaluate(() => localStorage.getItem("pendingInvite"))).toBeNull();
});
