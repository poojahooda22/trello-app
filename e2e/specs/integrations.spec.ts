import type { Page } from "@playwright/test";
import { createHmac } from "node:crypto";

import { API_URL } from "../env";
import { test, expect, type ApiClient } from "../fixtures";

/**
 * Integrations in the state the E2E stack actually runs them: INTEGRATION_KEY is
 * set so the Slack webhook can be encrypted, but GITHUB_APP_ID and
 * GITHUB_PRIVATE_KEY are empty, so the app can never create or close a GitHub
 * issue. That is the interesting half — the happy path needs credentials nobody
 * should put in a test run, while the degraded path is what a real board hits on
 * day one and what the panel has to explain.
 *
 * Nothing here may reach the outside world. Two rules keep that true:
 *
 *  - The Slack webhook below is shaped like a real one (SLACK_WEBHOOK_PATTERN
 *    accepts only https://hooks.slack.com/services/…) but its team and hook ids
 *    are invented, and no spec ever clicks "Send test message" while the
 *    integration is connected AND enabled — that button really does POST to
 *    hooks.slack.com. The two branches that answer without sending anything
 *    (not connected, paused) are driven through the endpoint instead.
 *  - No card is created or moved on a Slack-connected board: notifyBoard() fires
 *    a send off the response path, so a card write there would leave the process
 *    while the spec was already green.
 *
 * GitHub needs no such care: githubAppConfigured is false, so binding a
 * repository never calls api.github.com at all. The repository names are still
 * per-board and obviously fake, because `provider + externalId` is unique across
 * the whole database and parallel workers share it.
 */

/** Shaped like a Slack webhook, belonging to no workspace anywhere. */
const WEBHOOK_URL = "https://hooks.slack.com/services/T0E2E0TEAM/B0E2E0HOOK/e2e-unreachable-secret-tail";
/** What hintFor() makes of it: the team id, then the last four characters. */
const WEBHOOK_HINT = "T0E2E0TEAM/…/••••tail";

/** Mirrors the backend's IntegrationStatus — the JSON the panel renders. */
type IntegrationStatus = {
  provider: "SLACK" | "GITHUB";
  connected: boolean;
  enabled: boolean;
  label: string | null;
  hint: string | null;
  externalId: string | null;
  mirrorIssues: boolean;
  canWrite: boolean;
  lastEventAt: string | null;
  lastError: string | null;
};

/**
 * One provider's card. `<section>` carries no accessible name of its own, so the
 * card is identified by the heading inside it — both cards otherwise render the
 * same badges and the same button labels.
 */
const providerCard = (page: Page, provider: "Slack" | "GitHub") =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: provider, level: 2 }) });

async function readIntegrations(api: ApiClient, boardId: string): Promise<IntegrationStatus[]> {
  const { request, headers } = api.raw();
  const res = await request.get(`${API_URL}/board/${boardId}/integrations`, { headers });
  if (!res.ok()) throw new Error(`reading integrations failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as IntegrationStatus[];
}

/** Names its own cause when the row is missing, rather than failing on `undefined`. */
function of(list: IntegrationStatus[], provider: IntegrationStatus["provider"]): IntegrationStatus {
  const found = list.find((s) => s.provider === provider);
  if (!found) throw new Error(`no ${provider} row in ${JSON.stringify(list)}`);
  return found;
}

test("the integrations panel lists both providers, neither connected", async ({ page, api, board }) => {
  await page.goto(`/boards/${board.id}/settings`);
  await expect(page.getByRole("heading", { name: "Zepto Board settings", level: 1 })).toBeVisible();

  const slack = providerCard(page, "Slack");
  const github = providerCard(page, "GitHub");

  await expect(slack.getByRole("img", { name: "Slack" })).toBeVisible();
  await expect(slack.getByText("Not connected")).toBeVisible();
  await expect(slack.getByLabel("Incoming webhook URL")).toHaveValue("");
  // Nothing to submit until a URL is typed.
  await expect(slack.getByRole("button", { name: "Connect Slack" })).toBeDisabled();

  await expect(github.getByRole("img", { name: "GitHub" })).toBeVisible();
  await expect(github.getByText("Not connected")).toBeVisible();
  await expect(
    github.getByRole("checkbox", { name: "Also create a GitHub issue when a card is added here" }),
  ).toBeChecked();
  await expect(github.getByRole("button", { name: "Connect repository" })).toBeDisabled();

  // Neither card offers to pause or remove something that does not exist.
  await expect(slack.getByRole("button", { name: "Send test message" })).toHaveCount(0);
  await expect(github.getByRole("button", { name: "Disconnect" })).toHaveCount(0);

  const list = await readIntegrations(api, board.id);
  expect(list.map((s) => s.provider)).toEqual(["SLACK", "GITHUB"]);
  // Both rows are synthesised by emptyStatus(), not read from the database —
  // and GitHub already reports canWrite:false, before any repository is chosen,
  // because the App credentials are empty. No repository could change that.
  expect(of(list, "SLACK")).toMatchObject({ connected: false, enabled: false, hint: null, canWrite: true });
  expect(of(list, "GITHUB")).toMatchObject({ connected: false, enabled: false, externalId: null, canWrite: false });
});

test("connecting Slack hands the UI a masked hint and never the URL back", async ({ page, api, board }) => {
  await page.goto(`/boards/${board.id}/settings`);
  const slack = providerCard(page, "Slack");

  await slack.getByLabel("Incoming webhook URL").fill(WEBHOOK_URL);
  await slack.getByLabel("Channel name (optional, for display)").fill("#e2e-nowhere");

  const connected = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith("/integration/slack"),
  );
  await slack.getByRole("button", { name: "Connect Slack" }).click();
  const response = await connected;
  // Checked before the leak assertions below: a rejected connect answers with a
  // body that contains no secret either, so without this they would all pass on
  // a broken route and the failure would surface later as a missing badge.
  expect(response.status()).toBe(200);
  const body = await response.text();

  // Encrypting the webhook is pointless if the response hands it straight back.
  // Asserting against the raw text rather than a parsed field catches it leaking
  // through any field, including one added later.
  expect(body).not.toContain(WEBHOOK_URL);
  expect(body).not.toContain("B0E2E0HOOK");
  expect(body).not.toContain("e2e-unreachable-secret");

  await expect(slack.getByText("Connected", { exact: true })).toBeVisible();
  await expect(slack.getByText(WEBHOOK_HINT)).toBeVisible();
  await expect(slack.getByText("#e2e-nowhere")).toBeVisible();
  // Storing a webhook is not delivering to one: nothing has been sent, and the
  // card must not imply otherwise.
  await expect(slack.getByText("never", { exact: true })).toBeVisible();
  // The field is gone with the form — the URL is write-only from here on.
  await expect(slack.getByLabel("Incoming webhook URL")).toHaveCount(0);

  const list = await readIntegrations(api, board.id);
  expect(of(list, "SLACK")).toMatchObject({
    connected: true,
    enabled: true,
    hint: WEBHOOK_HINT,
    label: "#e2e-nowhere",
    lastEventAt: null,
    lastError: null,
  });
  // The list endpoint is the other way the browser could learn the secret.
  expect(JSON.stringify(list)).not.toContain(WEBHOOK_URL);
});

test("the Slack test endpoint reports a refusal instead of throwing", async ({ api, board }) => {
  const { request, headers } = api.raw();
  const testUrl = `${API_URL}/board/${board.id}/integration/slack/test`;

  // Driven over HTTP rather than through the button on purpose: the button is
  // only rendered once Slack is connected and enabled, and clicking it then
  // would POST to hooks.slack.com for real. These are the two branches that
  // answer without a single outbound byte.
  const notConnected = await request.post(testUrl, { headers });
  // A 200 carrying the reason, not a 500. "Nothing was sent" is an answer.
  expect(notConnected.status()).toBe(200);
  expect(await notConnected.json()).toMatchObject({ ok: false, error: "Slack is not connected to this board" });

  const seeded = await request.put(`${API_URL}/board/${board.id}/integration/slack`, {
    headers,
    data: { webhookUrl: WEBHOOK_URL, label: "#e2e-nowhere" },
  });
  expect(seeded.ok()).toBe(true);
  const pausedRes = await request.patch(`${API_URL}/board/${board.id}/integration/SLACK`, {
    headers,
    data: { enabled: false },
  });
  expect(pausedRes.ok()).toBe(true);

  const paused = await request.post(testUrl, { headers });
  expect(paused.status()).toBe(200);
  const payload = (await paused.json()) as { ok: boolean; error: string | null; integrations: IntegrationStatus[] };
  expect(payload).toMatchObject({ ok: false, error: "Slack is paused for this board — resume it first" });

  // A skip is not a failed delivery: sendSlack returns before it touches the
  // row, so a paused board must not go red over a message it never attempted —
  // and must not claim a delivery either.
  expect(of(payload.integrations, "SLACK").lastError).toBeNull();
  expect(of(payload.integrations, "SLACK").lastEventAt).toBeNull();
});

test("Slack can be paused, resumed and disconnected from the panel", async ({ page, api, board }) => {
  const { request, headers } = api.raw();
  const seeded = await request.put(`${API_URL}/board/${board.id}/integration/slack`, {
    headers,
    data: { webhookUrl: WEBHOOK_URL, label: "#e2e-nowhere" },
  });
  expect(seeded.ok()).toBe(true);

  await page.goto(`/boards/${board.id}/settings`);
  const slack = providerCard(page, "Slack");
  const testButton = slack.getByRole("button", { name: "Send test message" });

  await expect(slack.getByText("Connected", { exact: true })).toBeVisible();
  // Asserted enabled, deliberately never clicked — see the file header.
  await expect(testButton).toBeEnabled();

  await slack.getByRole("button", { name: "Pause" }).click();
  // Paused is neutral, not green: "connected but not sending" must not read as
  // success anywhere on the card.
  await expect(slack.getByText("Paused", { exact: true })).toBeVisible();
  await expect(testButton).toBeDisabled();
  await expect(testButton).toHaveAttribute("title", "Resume the integration to send a test message");

  await slack.getByRole("button", { name: "Resume" }).click();
  await expect(slack.getByText("Connected", { exact: true })).toBeVisible();
  await expect(testButton).toBeEnabled();

  await slack.getByRole("button", { name: "Disconnect" }).click();
  await expect(slack.getByText("Not connected")).toBeVisible();
  // The credential is gone rather than hidden: the form is back and the hint is
  // not, and the row itself no longer exists.
  await expect(slack.getByLabel("Incoming webhook URL")).toBeVisible();
  await expect(slack.getByText(WEBHOOK_HINT)).toHaveCount(0);
  expect(of(await readIntegrations(api, board.id), "SLACK")).toMatchObject({ connected: false, hint: null });
});

test("binding a repository warns that the App cannot write to it", async ({ page, api, board }) => {
  // Per-board and mixed case: `provider + externalId` is unique across the whole
  // database, and canonicalRepo lowercases before storing.
  const typed = `E2E-${board.id}/Zepto-API`;
  const stored = typed.toLowerCase();

  await page.goto(`/boards/${board.id}/settings`);
  const github = providerCard(page, "GitHub");
  await github.getByLabel("Repository").fill(typed);

  const bound = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/integration/github"));
  await github.getByRole("button", { name: "Connect repository" }).click();
  const payload = (await (await bound).json()) as { warning: string | null; integrations: IntegrationStatus[] };

  // This exact sentence is written by one branch only — the `else` that runs
  // when githubAppConfigured is false and therefore never enters the block that
  // calls findInstallationForRepo. The branch that did try the network answers
  // "Could not reach GitHub: …" instead, so the wording identifies which path
  // ran, and this assertion is the whole proof that binding short-circuited.
  expect(payload.warning).toBe("GITHUB_APP_ID / GITHUB_PRIVATE_KEY are not set, so cards cannot be pushed to GitHub.");

  expect(of(payload.integrations, "GITHUB")).toMatchObject({
    connected: true,
    enabled: true,
    // No installation could be discovered, so outbound writes are impossible.
    canWrite: false,
    mirrorIssues: true,
    externalId: stored,
  });

  await expect(
    github.getByText("GITHUB_APP_ID / GITHUB_PRIVATE_KEY are not set, so cards cannot be pushed to GitHub."),
  ).toBeVisible();
  await expect(github.getByText("The app can read events from this repository but cannot write to it")).toBeVisible();
  // The panel shows what was stored, not what was typed: "one repository, one
  // board" is enforced on the lowercased name.
  await expect(github.getByRole("link", { name: stored })).toBeVisible();
  await expect(github.getByText("On — new cards open a GitHub issue")).toBeVisible();
  // Connected and failing are different axes. Nothing has failed — the board
  // simply cannot write — so the badge stays green rather than red.
  await expect(github.getByText("Connected", { exact: true })).toBeVisible();
});

test("toggling the mirror does not re-run repository binding", async ({ page, api, board }) => {
  const repository = `e2e-${board.id}/mirror-check`;
  const { request, headers } = api.raw();
  const bound = await request.put(`${API_URL}/board/${board.id}/integration/github`, {
    headers,
    data: { repository, mirrorIssues: true },
  });
  expect(bound.ok()).toBe(true);
  // Paused on purpose: the connect route sets enabled:true and clears lastError,
  // so a mirror toggle that quietly re-ran it would resume a link an admin had
  // deliberately stopped. That silent resume is the regression under test.
  const paused = await request.patch(`${API_URL}/board/${board.id}/integration/GITHUB`, {
    headers,
    data: { enabled: false },
  });
  expect(paused.ok()).toBe(true);

  await page.goto(`/boards/${board.id}/settings`);
  const github = providerCard(page, "GitHub");
  await expect(github.getByText("Paused", { exact: true })).toBeVisible();
  await expect(github.getByText("On — new cards open a GitHub issue")).toBeVisible();

  const writes: string[] = [];
  page.on("request", (req) => {
    const method = req.method();
    // OPTIONS is the browser's CORS preflight, not a call the app chose to make.
    if (method !== "OPTIONS" && req.url().includes("/integration/github")) writes.push(`${method} ${req.url()}`);
  });

  await github.getByRole("button", { name: "Stop mirroring cards" }).click();

  await expect(github.getByText("Off — GitHub → board only")).toBeVisible();
  await expect(github.getByText("Paused", { exact: true })).toBeVisible();
  await expect(github.getByRole("link", { name: repository })).toBeVisible();

  // The direct evidence: one PATCH to the mirror endpoint, and no PUT to the
  // binding endpoint at all.
  expect(writes).toContain(`PATCH ${API_URL}/board/${board.id}/integration/github/mirror`);
  expect(writes.filter((w) => w.startsWith("PUT"))).toEqual([]);

  expect(of(await readIntegrations(api, board.id), "GITHUB")).toMatchObject({
    mirrorIssues: false,
    enabled: false,
    externalId: repository,
    canWrite: false,
  });
});

test("a webhook URL that is not Slack's is refused, not stored", async ({ page, api, board }) => {
  await page.goto(`/boards/${board.id}/settings`);
  const slack = providerCard(page, "Slack");

  await slack.getByLabel("Incoming webhook URL").fill("not-a-url");
  await slack.getByRole("button", { name: "Connect Slack" }).click();
  // The schema's own sentence reaches the user; a bare "Invalid request body"
  // would leave them with nothing to fix.
  await expect(slack.getByRole("status")).toHaveText(
    "Invalid request body: Must be a https://hooks.slack.com/services/… URL",
  );
  await expect(slack.getByText("Not connected")).toBeVisible();

  const { request, headers } = api.raw();
  const connect = (webhookUrl: string) =>
    request.put(`${API_URL}/board/${board.id}/integration/slack`, { headers, data: { webhookUrl } });

  // The origin half of the pattern is the SSRF guard: without it, a pasted URL
  // turns the server into a client for whatever it points at, on a schedule the
  // paster controls. The lookalike host is the one that gets past eyeballs.
  for (const [url, why] of [
    ["http://hooks.slack.com/services/T0/B0/tail", "http rather than https"],
    ["https://hooks.slack.com/services/", "no webhook path at all"],
    ["https://hooks.slack.com.evil.example/services/T0/B0/tail", "a lookalike host"],
    ["https://evil.example.com/services/T0/B0/tail", "a different origin entirely"],
    ["https://hooks.slack.com/services/T0/B0/tail?x=1", "a query string"],
    ["https://hooks.slack.com/services/../../admin", "path traversal"],
    ["not-a-url", "not a URL"],
  ] as const) {
    const res = await connect(url);
    expect(res.status(), why).toBe(400);
    const body = (await res.json()) as { error: string; details: { fieldErrors: Record<string, string[]> } };
    expect(body.error, why).toBe("Invalid request body");
    expect(body.details.fieldErrors.webhookUrl?.[0], why).toBe(
      "Must be a https://hooks.slack.com/services/… URL",
    );
  }

  expect(of(await readIntegrations(api, board.id), "SLACK").connected).toBe(false);
  // The positive control: without it a pattern that rejected everything would
  // pass every assertion above.
  expect((await connect(WEBHOOK_URL)).ok()).toBe(true);
  expect(of(await readIntegrations(api, board.id), "SLACK").connected).toBe(true);
});

test("a repository that is not owner/repo is refused, not stored", async ({ page, api, board }) => {
  await page.goto(`/boards/${board.id}/settings`);
  const github = providerCard(page, "GitHub");

  await github.getByLabel("Repository").fill("owner/repo/extra");
  await github.getByRole("button", { name: "Connect repository" }).click();
  await expect(github.getByRole("status")).toHaveText('Invalid request body: Must be "owner/repo" or a github.com repository URL');
  await expect(github.getByText("Not connected")).toBeVisible();

  const { request, headers } = api.raw();
  const connect = (repository: string) =>
    request.put(`${API_URL}/board/${board.id}/integration/github`, { headers, data: { repository } });

  // GitHub's own constraint, checked before we try to bind it. A URL on any
  // other host is refused too: it would silently never receive webhooks.
  for (const [repository, why] of [
    ["just-a-name", "no owner"],
    ["owner/repo/extra", "an extra path segment"],
    ["https://gitlab.com/owner/repo", "a URL on another host"],
    ["owner /repo", "a space in the owner"],
    ["owner/", "no repository name"],
    ["", "empty"],
  ] as const) {
    const res = await connect(repository);
    expect(res.status(), why).toBe(400);
    const body = (await res.json()) as { error: string; details: { fieldErrors: Record<string, string[]> } };
    expect(body.error, why).toBe("Invalid request body");
    expect(body.details.fieldErrors.repository?.[0], why).toBe('Must be "owner/repo" or a github.com repository URL');
  }

  expect(of(await readIntegrations(api, board.id), "GITHUB").connected).toBe(false);
  // Positive control, per-board so parallel workers cannot collide on the
  // global `provider + externalId` uniqueness.
  expect((await connect(`e2e-${board.id}/pattern-check`)).ok()).toBe(true);
  expect(of(await readIntegrations(api, board.id), "GITHUB")).toMatchObject({
    connected: true,
    externalId: `e2e-${board.id}/pattern-check`,
    canWrite: false,
  });
  // The pasted browser URL is the mistake a real admin actually makes, so it
  // is accepted and reduced to owner/repo — lowercased, as GitHub resolves
  // names case-insensitively and one repository must map to one board.
  expect((await connect(`https://github.com/E2E-${board.id}/Pasted/tree/main`)).ok()).toBe(true);
  expect(of(await readIntegrations(api, board.id), "GITHUB")).toMatchObject({
    connected: true,
    externalId: `e2e-${board.id}/pasted`,
    canWrite: false,
  });
});

/** Signs a webhook body the way GitHub does, with the secret playwright.config.ts hands the E2E backend. */
const signed = (body: string) => "sha256=" + createHmac("sha256", "e2e-github-webhook-secret").update(body).digest("hex");

test("deleting a card the App cannot write to leaves its GitHub issue, and says so first", async ({ page, api, board }) => {
  const repository = `e2e-${board.id}/delete-check`;
  const { request, headers } = api.raw();
  expect((await request.put(`${API_URL}/board/${board.id}/integration/github`, { headers, data: { repository } })).ok()).toBe(true);

  // The only way a card gets a GitHub number without credentials is GitHub's
  // own webhook, so one is forged here and signed with the E2E secret.
  const title = "Courier app crashes on launch";
  const body = JSON.stringify({
    action: "opened",
    issue: {
      number: 41,
      title,
      body: "Filed on GitHub.",
      html_url: `https://github.com/${repository}/issues/41`,
      state: "open",
      user: { login: "e2e-reporter" },
    },
    repository: { full_name: repository },
    sender: { login: "e2e-reporter", type: "User" },
  });
  const delivered = await request.post(`${API_URL}/webhooks/github`, {
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": `e2e-${board.id}-41`,
      "x-hub-signature-256": signed(body),
    },
    data: body,
  });
  expect(delivered.status()).toBe(202);
  // The route answers inside GitHub's window and does the work after, so the
  // card is polled for rather than assumed.
  const findCard = async () => (await api.getSections(board.id)).sections.flatMap((s) => s.issues).find((i) => i.title === title);
  await expect.poll(async () => Boolean(await findCard())).toBe(true);
  const card = (await findCard())!;

  await page.goto(`/boards/${board.id}/issues/${card.id}`);
  await page.getByRole("button", { name: "Delete this issue" }).click();
  // Said before the click, not after: this stack has no App credentials, so
  // the confirmation must not promise GitHub anything.
  await expect(page.getByText(`GitHub issue #41 stays: the GitHub App cannot write to ${repository}.`)).toBeVisible();
  await page.getByRole("button", { name: "Yes, delete" }).click();

  // The card went, GitHub was not touched, and the page says so while the
  // person is still on it — the board has nowhere to say it.
  await expect(
    page.getByText(`${card.key} was deleted. GitHub issue #41 was left as it is (GITHUB_APP_ID / GITHUB_PRIVATE_KEY are not set).`),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/issues/${card.id}$`));
  await page.getByRole("button", { name: "Back to board" }).click();
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}$`));
  expect((await api.getSections(board.id)).sections.flatMap((s) => s.issues)).toEqual([]);
});
