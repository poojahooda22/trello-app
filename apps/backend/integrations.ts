/**
 * Per-board integrations. Each board carries its own Slack webhook URL, so a
 * team's card activity goes to their channel and nobody else's. The URL is a
 * secret: it is encrypted at rest and never sent back to a browser.
 */
import { prisma } from "db/client";

import { githubAppConfigured } from "./github-app";
import { decryptSecret, encryptSecret } from "./secrets";

/**
 * Slack mrkdwn treats &, < and > as markup, and renders newlines as line
 * breaks — a card title with a newline could otherwise pose as a second,
 * system-authored message in the channel. Both are neutralised here.
 */
export const escapeSlack = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Only this exact origin is accepted, so a pasted mistake (or a malicious
 * paste) can never turn the server into an SSRF client. Overridable for a
 * Slack-compatible gateway and for tests that must not call the real Slack.
 */
const SLACK_ORIGIN = process.env.SLACK_WEBHOOK_ORIGIN ?? "https://hooks.slack.com";
export const SLACK_WEBHOOK_PATTERN = new RegExp(
  `^${SLACK_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/services/[A-Za-z0-9/_-]+$`,
);

/** What the UI is allowed to see: enough to recognise the connection, not enough to use it. */
export type IntegrationStatus = {
  provider: "SLACK" | "GITHUB";
  connected: boolean;
  enabled: boolean;
  label: string | null;
  hint: string | null;
  /** GitHub: "owner/repo". Slack: null (its identifier is the secret). */
  externalId: string | null;
  /** GitHub: also create a GitHub issue when a card is created here. */
  mirrorIssues: boolean;
  /** GitHub: false when the App credentials are missing, so writes are impossible. */
  canWrite: boolean;
  lastEventAt: string | null;
  lastError: string | null;
};

/** A link back to the board, so a Slack message is one click from the work. */
const APP_URL = process.env.APP_URL ?? "http://localhost:5173";
export const boardLink = (boardId: string, text: string) =>
  `<${APP_URL}/boards/${boardId}|${escapeSlack(text)}>`;

/** "…/T01AB/B02CD/xxxxxxxxYtQ7" → "…/B02CD/••••Q7" — recognisable, unusable. */
function hintFor(url: string): string {
  const parts = url.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "";
  const team = parts.at(-3) ?? "";
  return `${team}/…/••••${last.slice(-4)}`;
}

export const emptyStatus = (provider: IntegrationStatus["provider"]): IntegrationStatus => ({
  provider,
  connected: false,
  enabled: false,
  label: null,
  hint: null,
  externalId: null,
  mirrorIssues: false,
  canWrite: provider === "GITHUB" ? githubAppConfigured : true,
  lastEventAt: null,
  lastError: null,
});

export async function listIntegrations(boardId: string): Promise<IntegrationStatus[]> {
  const rows = await prisma.boardIntegration.findMany({ where: { boardId } });
  return (["SLACK", "GITHUB"] as const).map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    if (!row) return emptyStatus(provider);
    let hint: string | null = null;
    try {
      hint = provider === "SLACK" && row.config ? hintFor(decryptSecret(row.config)) : null;
    } catch {
      hint = null; // undecryptable (key rotated): shown as connected but broken
    }
    return {
      provider,
      connected: true,
      enabled: row.enabled,
      label: row.label,
      hint,
      externalId: row.externalId,
      mirrorIssues: row.mirrorIssues,
      canWrite: provider === "GITHUB" ? githubAppConfigured && row.installationId !== null : true,
      lastEventAt: row.lastEventAt?.toISOString() ?? null,
      lastError: row.lastError,
    };
  });
}

/** "owner/repo" — GitHub's own constraint, checked before we try to bind it. */
export const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * People paste what the browser gives them, which is the repository URL, not
 * the "owner/repo" the API wants. Accept both: a bare owner/repo, or any
 * github.com URL — with or without the scheme, a trailing slash, ".git", or a
 * deeper path like /tree/main. Returns null for anything else, including URLs
 * on other hosts, which would silently never receive webhooks.
 */
export function parseRepoInput(raw: string): string | null {
  const input = raw.trim();
  if (REPO_PATTERN.test(input)) return input;

  let path: string;
  const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") return null;
    path = url.pathname;
  } catch {
    return null;
  }
  const [owner, repo] = path.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  const candidate = `${owner}/${repo.replace(/\.git$/i, "")}`;
  return REPO_PATTERN.test(candidate) ? candidate : null;
}

/**
 * GitHub resolves repository names case-insensitively, so "Acme/API" and
 * "acme/api" are one repository. Storing and looking up a single casing is what
 * makes "one repository, one board" an invariant instead of a convention.
 */
export const canonicalRepo = (fullName: string) => fullName.toLowerCase();

export async function connectGitHub(
  boardId: string,
  fullName: string,
  installationId: number | null,
  mirrorIssues: boolean,
) {
  const externalId = canonicalRepo(fullName);
  const existing = await prisma.boardIntegration.findUnique({
    where: { boardId_provider: { boardId, provider: "GITHUB" } },
    select: { externalId: true },
  });
  const repoChanged = existing !== null && existing.externalId !== externalId;

  await prisma.$transaction(async (tx) => {
    await tx.boardIntegration.upsert({
      where: { boardId_provider: { boardId, provider: "GITHUB" } },
      create: { boardId, provider: "GITHUB", externalId, installationId, mirrorIssues, label: externalId },
      update: {
        externalId,
        mirrorIssues,
        label: externalId,
        enabled: true,
        lastError: null,
        // A failed lookup must not erase an installation we already had: only
        // overwrite when we learned one, or when the repository itself changed.
        ...(installationId !== null || repoChanged ? { installationId } : {}),
      },
    });
    // Card ↔ issue links belong to the OLD repository. Left in place, issue #12
    // in the new repository would edit — or delete — an unrelated card.
    if (repoChanged) {
      await tx.issue.updateMany({ where: { boardId }, data: { githubNumber: null } });
    }
  });
}

/** The mirror flag on its own, so toggling it never re-runs repository binding. */
export async function setMirrorIssues(boardId: string, mirrorIssues: boolean) {
  await prisma.boardIntegration.updateMany({
    where: { boardId, provider: "GITHUB" },
    data: { mirrorIssues },
  });
}

export type RepoLink = { boardId: string; fullName: string; installationId: number | null; mirrorIssues: boolean; enabled: boolean };

/** The board a repository is bound to. Webhooks act only within this board. */
export async function boardForRepo(fullName: string): Promise<RepoLink | null> {
  const row = await prisma.boardIntegration.findUnique({
    where: { provider_externalId: { provider: "GITHUB", externalId: canonicalRepo(fullName) } },
  });
  if (!row) return null;
  return {
    boardId: row.boardId,
    fullName: row.externalId ?? canonicalRepo(fullName),
    installationId: row.installationId,
    mirrorIssues: row.mirrorIssues,
    enabled: row.enabled,
  };
}

/** The board's repository link, for outbound writes. */
export async function repoForBoard(boardId: string): Promise<RepoLink | null> {
  const row = await prisma.boardIntegration.findUnique({
    where: { boardId_provider: { boardId, provider: "GITHUB" } },
  });
  if (!row?.externalId) return null;
  return {
    boardId,
    fullName: row.externalId,
    installationId: row.installationId,
    mirrorIssues: row.mirrorIssues,
    enabled: row.enabled,
  };
}

/** Records the outcome of a GitHub interaction on the board's integration row. */
export async function recordGitHub(boardId: string, error: string | null): Promise<void> {
  await prisma.boardIntegration.updateMany({
    where: { boardId, provider: "GITHUB" },
    data: error ? { lastError: error } : { lastEventAt: new Date(), lastError: null },
  });
}

export async function connectSlack(boardId: string, webhookUrl: string, label: string | null) {
  const config = encryptSecret(webhookUrl);
  await prisma.boardIntegration.upsert({
    where: { boardId_provider: { boardId, provider: "SLACK" } },
    create: { boardId, provider: "SLACK", config, label, enabled: true },
    update: { config, label, enabled: true, lastError: null },
  });
}

export async function disconnect(boardId: string, provider: IntegrationStatus["provider"]) {
  await prisma.$transaction(async (tx) => {
    await tx.boardIntegration.deleteMany({ where: { boardId, provider } });
    // Same reason as a re-bind: a number that outlives its repository would
    // later be matched against whatever repository is bound next.
    if (provider === "GITHUB") {
      await tx.issue.updateMany({ where: { boardId }, data: { githubNumber: null } });
    }
  });
}

export async function setEnabled(boardId: string, provider: IntegrationStatus["provider"], enabled: boolean) {
  // Clearing the error on both edges: a paused integration should read
  // "Paused", not stay red forever from a failure it can no longer retry.
  await prisma.boardIntegration.updateMany({ where: { boardId, provider }, data: { enabled, lastError: null } });
}

/** "Nothing was sent" and "sent successfully" are different answers — the caller must be able to tell. */
export type SendResult =
  | { status: "sent" }
  | { status: "skipped"; reason: "not_connected" | "paused" }
  | { status: "failed"; error: string };

/** Slack normally answers in well under a second; a hung gateway must not hold a request open. */
const SEND_TIMEOUT_MS = 5_000;

/** Posts to the board's Slack webhook. */
export async function sendSlack(boardId: string, text: string): Promise<SendResult> {
  const row = await prisma.boardIntegration.findUnique({
    where: { boardId_provider: { boardId, provider: "SLACK" } },
  });
  if (!row?.config) return { status: "skipped", reason: "not_connected" };
  if (!row.enabled) return { status: "skipped", reason: "paused" };

  let error: string | null = null;
  try {
    const url = decryptSecret(row.config);
    // Re-check at send time: a row edited in the database cannot redirect us.
    if (!SLACK_WEBHOOK_PATTERN.test(url)) throw new Error("Stored webhook URL is not a Slack webhook");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Slack answers 429 with Retry-After, and a revoked webhook with no_service.
      const retryAfter = res.headers.get("retry-after");
      error = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Stamped on the row this send actually used: if the admin reconnected while
  // the request was in flight, the new integration must not inherit the result.
  await prisma.boardIntegration.updateMany({
    where: { id: row.id },
    data: error ? { lastError: error } : { lastEventAt: new Date(), lastError: null },
  });
  return error ? { status: "failed", error } : { status: "sent" };
}

/**
 * Fire-and-forget notification for a board change that is already committed:
 * the request must not wait on Slack, and a Slack failure must not fail it.
 */
export function notifyBoard(boardId: string, text: string): void {
  sendSlack(boardId, text)
    .then((result) => {
      if (result.status === "failed") console.error(`[slack] board ${boardId}: ${result.error}`);
    })
    .catch((err) => console.error(`[slack] board ${boardId}:`, err));
}
