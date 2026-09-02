import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { API_URL } from "../env";
import { test as base, expect, authenticate } from "../fixtures";

/**
 * Getting in, and being kept out.
 *
 * The whole auth surface is four things: two forms, one JWT in localStorage,
 * and requireAuth on the backend. Everything below drives one of those and
 * asserts what the *other* side did about it — a form submission is only
 * interesting because of the status the API answered with, and a token is only
 * interesting because of what the page renders once it stops working.
 *
 * Two facts about this app shape most of these specs, and both are easy to
 * assume wrongly:
 *
 *  1. The router has exactly ONE auth check, in routes/index.tsx. `/boards` and
 *     `/boards/$boardId` have no beforeLoad at all. A visitor with no token
 *     therefore *reaches* the boards page; it is the 401 on its query, not a
 *     redirect, that stops them. Specs here assert that reality rather than the
 *     redirect a reader might expect.
 *  2. Validation is two layers that disagree. The inputs carry `required` and
 *     `type="email"`, and the backend carries a stricter zod schema. Which
 *     layer refuses a given value is the thing worth pinning down.
 */

const PASSWORD = "e2e-password-1234";

const test = base.extend<{ visitor: Page }>({
  /**
   * A browser that has never signed in. The `page` fixture arrives with a token
   * already injected, which is exactly wrong for a file about acquiring one.
   *
   * Made a fixture rather than a `browser.newContext()` per test so teardown
   * still runs when an assertion throws — the suite is fullyParallel and a
   * context leaked per failure is paid for by every later worker.
   */
  visitor: async ({ browser }, use) => {
    const context = await browser.newContext();
    await use(await context.newPage());
    await context.close();
  },
});

test("signing up through the form lands on the boards, actually signed in", async ({ visitor }) => {
  const email = `e2e-ui-${randomUUID()}@example.test`;

  await visitor.goto("/signup");
  await expect(visitor.getByRole("heading", { name: "Sign up to continue" })).toBeVisible();

  await visitor.getByLabel("Email").fill(email);
  await visitor.getByLabel("Password").fill(PASSWORD);
  await visitor.getByRole("button", { name: "Sign up" }).click();

  await expect(visitor).toHaveURL(/\/boards$/);
  // The main panel's empty state. Matched on this fragment because the sidebar
  // renders its own "No workspaces yet." — the shorter string hits both.
  await expect(visitor.getByText("create one above")).toBeVisible();

  // The account menu is drawn from GET /me, so seeing the address come back
  // proves the stored token authenticates. Landing on /boards alone would only
  // prove navigate() ran.
  await visitor.getByRole("button", { name: "Account menu" }).click();
  await expect(visitor.getByText(email)).toBeVisible();

  // And the token outlived the mutation: "/" is the router's only guard, and it
  // now resolves the other way.
  await visitor.goto("/");
  await expect(visitor).toHaveURL(/\/boards$/);
});

test("an existing account signs in and lands on its own workspace", async ({ visitor, user, org }) => {
  await visitor.goto("/signin");
  await expect(visitor.getByRole("heading", { name: "Welcome Back" })).toBeVisible();

  await visitor.getByLabel("Email").fill(user.email);
  await visitor.getByLabel("Password").fill(user.password);
  await visitor.getByRole("button", { name: "Log in" }).click();

  await expect(visitor).toHaveURL(/\/boards$/);
  // The workspace this test's own fixtures made over the API. Asserting on it
  // rather than on the page chrome is what makes this "signed in as `user`"
  // instead of "signed in as somebody". The sidebar lists the same name inside
  // a link, so the heading role is what disambiguates.
  await expect(visitor.getByRole("heading", { name: org.name })).toBeVisible();
});

test("a wrong password and an unknown address are refused identically", async ({ visitor, user, anon }) => {
  await visitor.goto("/signin");
  await visitor.getByLabel("Email").fill(user.email);
  await visitor.getByLabel("Password").fill("definitely-not-the-password");
  await visitor.getByRole("button", { name: "Log in" }).click();

  await expect(visitor.getByText("Invalid email or password")).toBeVisible();
  // A failed sign-in must not navigate: the form stays put so the address is
  // still typed in.
  await expect(visitor).toHaveURL(/\/signin$/);

  // The non-enumeration property itself. index.ts collapses "no such user" and
  // "wrong password" into one branch on purpose, so the two answers have to be
  // byte-identical — anything that differed (a status, a message, even key
  // order) would turn /signin into an address-existence oracle.
  const wrongPassword = await anon.post(`${API_URL}/signin`, {
    data: { email: user.email, password: "definitely-not-the-password" },
  });
  const unknownEmail = await anon.post(`${API_URL}/signin`, {
    data: { email: `nobody-${randomUUID()}@example.test`, password: user.password },
  });

  expect(wrongPassword.status()).toBe(401);
  expect(unknownEmail.status()).toBe(401);
  expect(await unknownEmail.text()).toBe(await wrongPassword.text());
});

test("a malformed address never leaves the browser", async ({ visitor }) => {
  const posts: string[] = [];
  visitor.on("request", (req) => {
    if (req.method() === "POST" && req.url().startsWith(API_URL)) posts.push(req.url());
  });

  await visitor.goto("/signup");
  await visitor.getByLabel("Email").fill("not-an-email");
  await visitor.getByLabel("Password").fill(PASSWORD);
  await visitor.getByRole("button", { name: "Sign up" }).click();

  await expect(visitor).toHaveURL(/\/signup$/);
  // Why the click did nothing: the input is type="email", so constraint
  // validation fails the form and React's onSubmit — and the fetch inside it —
  // never run.
  const typeMismatch = await visitor
    .getByLabel("Email")
    .evaluate((el) => (el as HTMLInputElement).validity.typeMismatch);
  expect(typeMismatch).toBe(true);

  // Correcting the address and getting all the way to /boards is the
  // synchronisation point for the assertion below: had the first click sent
  // anything, it would have landed in `posts` long before this resolved.
  await visitor.getByLabel("Email").fill(`e2e-recovered-${randomUUID()}@example.test`);
  await visitor.getByRole("button", { name: "Sign up" }).click();
  await expect(visitor).toHaveURL(/\/boards$/);

  expect(posts).toEqual([`${API_URL}/signup`]);
});

test("an address the browser accepts can still fail the server's stricter rule", async ({ visitor, anon }) => {
  // "nobody@example" is the case where the two validation layers genuinely
  // disagree. HTML5's type=email treats the dotted part of the domain as
  // optional, so the browser submits it; zod's z.email() defaults to a pattern
  // that demands `(label.)+TLD{2,}`, so the server refuses it. The layers are
  // not redundant, and the server is the one that decides.
  await visitor.goto("/signup");
  await visitor.getByLabel("Email").fill("nobody@example");
  await visitor.getByLabel("Password").fill(PASSWORD);
  await visitor.getByRole("button", { name: "Sign up" }).click();

  await expect(visitor.getByText("Invalid request body")).toBeVisible();
  await expect(visitor).toHaveURL(/\/signup$/);

  const res = await anon.post(`${API_URL}/signup`, { data: { email: "nobody@example", password: PASSWORD } });
  expect(res.status()).toBe(400);
  // The detail the form drops on the floor: lib/api.ts's signup() surfaces
  // body.error only, while the generic request() helper unpacks fieldErrors.
  const body = (await res.json()) as { details: { fieldErrors: Record<string, string[]> } };
  expect(body.details.fieldErrors.email).toBeDefined();
  // And the address is the ONLY reason: flattenError only creates a key for a
  // field that actually raised an issue, so an absent `password` is what makes
  // this a test about z.email() rather than about the 400 in general.
  expect(body.details.fieldErrors.password).toBeUndefined();
});

test("a password under eight characters is refused by the server, not the form", async ({ visitor, anon }) => {
  const email = `e2e-short-${randomUUID()}@example.test`;

  await visitor.goto("/signup");
  await visitor.getByLabel("Email").fill(email);
  // The password input has `required` but no minLength, so unlike the malformed
  // address above this one really is sent and really is answered 400.
  await visitor.getByLabel("Password").fill("short");
  await visitor.getByRole("button", { name: "Sign up" }).click();

  await expect(visitor.getByText("Invalid request body")).toBeVisible();
  await expect(visitor).toHaveURL(/\/signup$/);

  const res = await anon.post(`${API_URL}/signup`, { data: { email, password: "short" } });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { details: { fieldErrors: Record<string, string[]> } };
  expect(body.details.fieldErrors.password).toContain("Password must be at least 8 characters");

  // The rejected attempts left nothing half-made: the same address still signs
  // up cleanly, which a 409 off the unique index would disprove. Signin cannot
  // be used to check this — by design it answers 401 whether the row exists or
  // not (see the non-enumeration spec above).
  const retry = await anon.post(`${API_URL}/signup`, { data: { email, password: PASSWORD } });
  expect(retry.status()).toBe(201);
});

test("signing up with an address that already has an account is refused", async ({ visitor, user, anon }) => {
  await visitor.goto("/signup");
  await visitor.getByLabel("Email").fill(user.email);
  await visitor.getByLabel("Password").fill("a-different-password-9876");
  await visitor.getByRole("button", { name: "Sign up" }).click();

  // P2002 from the unique index on User.email, which the error middleware maps
  // to a generic 409 rather than naming the column. Worth noticing that this is
  // the opposite trade-off from /signin: signup does reveal that an address is
  // taken, because a form that silently failed instead would be unusable.
  await expect(visitor.getByText("That record already exists")).toBeVisible();
  await expect(visitor).toHaveURL(/\/signup$/);

  const res = await anon.post(`${API_URL}/signup`, { data: { email: user.email, password: "a-different-password-9876" } });
  expect(res.status()).toBe(409);

  // And the refused attempt did not overwrite the existing hash.
  const stillWorks = await anon.post(`${API_URL}/signin`, { data: { email: user.email, password: user.password } });
  expect(stillWorks.status()).toBe(200);
});

test('only "/" guards itself — a protected page leans on the API instead', async ({ visitor }) => {
  await visitor.goto("/");
  await expect(visitor).toHaveURL(/\/signup$/);

  // /boards has no beforeLoad, so it renders for anyone. lib/api.ts's bearer()
  // interpolates a missing token straight into the header, which reaches the
  // server as the literal "Bearer null" — past requireAuth's prefix check and
  // into jwt.verify, which is why a visitor with NO token is told the token is
  // invalid rather than missing.
  await visitor.goto("/boards");
  await expect(visitor).toHaveURL(/\/boards$/);
  await expect(visitor.getByText("Invalid or expired token")).toBeVisible();

  // The recovery path the page offers instead of a redirect.
  await visitor.getByRole("link", { name: "sign in again" }).click();
  await expect(visitor).toHaveURL(/\/signin$/);
  await expect(visitor.getByRole("heading", { name: "Welcome Back" })).toBeVisible();
});

test("a tampered token is refused by the API and renders nothing in the UI", async ({ visitor, user, anon }) => {
  const [header, payload, signature] = user.token.split(".");
  // Flip the first character of the payload. Whether jsonwebtoken then fails to
  // parse it or fails the HMAC, both land in requireAuth's catch — the point is
  // that a token the client can edit is worth nothing without the secret.
  const forged = [header, (payload[0] === "e" ? "f" : "e") + payload.slice(1), signature].join(".");

  const noHeader = await anon.get(`${API_URL}/me`);
  expect(noHeader.status()).toBe(401);
  expect((await noHeader.json()).error).toBe("Missing Bearer token");

  const tampered = await anon.get(`${API_URL}/me`, { headers: { Authorization: `Bearer ${forged}` } });
  expect(tampered.status()).toBe(401);
  expect((await tampered.json()).error).toBe("Invalid or expired token");

  // The untouched token against the same route, so the two 401s above are the
  // signature check doing its job and not /me being broken.
  const genuine = await anon.get(`${API_URL}/me`, { headers: { Authorization: `Bearer ${user.token}` } });
  expect(genuine.status()).toBe(200);
  expect((await genuine.json()).email).toBe(user.email);

  // Same forged token in the browser. Reusing the harness's injector: it only
  // writes localStorage before first navigation, and a value it cannot vouch
  // for is exactly what this needs.
  await authenticate(visitor, forged);
  await visitor.goto("/boards");
  await expect(visitor.getByText("Invalid or expired token")).toBeVisible();
  // Nothing rendered behind the error. Ordered after an awaited positive
  // assertion so the page has demonstrably finished loading — otherwise this
  // would pass on an empty frame and prove nothing.
  await expect(visitor.getByText("create one above")).toBeHidden();
});
