/**
 * GitHub webhook handling: the pure parts. No Express, no network — the route
 * in index.ts wires these to HTTP, and they can be tested without a server.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Card keys look like TRL-42. One prefix for every board until boards carry their own. */
export const ISSUE_KEY_PREFIX = "TRL";
const ISSUE_KEY = new RegExp(`\\b${ISSUE_KEY_PREFIX}-\\d+\\b`, "i");

/**
 * True when `X-Hub-Signature-256` equals HMAC-SHA256(secret, rawBody).
 * Compared in constant time so a mismatch reveals nothing about the secret.
 */
export function verifyGitHubSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const received = Buffer.from(signatureHeader.slice("sha256=".length));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** The first card key found in any of the texts (branch name, PR title…), upper-cased. */
export function findIssueKey(...texts: (string | undefined)[]): string | null {
  for (const text of texts) {
    const match = text?.match(ISSUE_KEY);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

// Only the fields the handler reads; zod drops the rest of the GitHub payload.
export const pullRequestEvent = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    html_url: z.string(),
    merged: z.boolean(),
    draft: z.boolean(),
    head: z.object({ ref: z.string() }),
    user: z.object({ login: z.string() }),
  }),
  repository: z.object({ full_name: z.string() }),
});
export type PullRequestEvent = z.infer<typeof pullRequestEvent>;

export type CardMove = { key: string; sectionId: "review" | "done"; reason: string; url: string };

/**
 * What a pull_request event should do to the board, or null to ignore it.
 *   opened / reopened / ready_for_review (not a draft) → Review
 *   closed with merged: true                           → Done
 * A PR closed without merging moves nothing: the card is still someone's work.
 */
export function planMoveForPullRequest(event: PullRequestEvent): CardMove | null {
  const { action, pull_request: pr, repository } = event;
  const key = findIssueKey(pr.head.ref, pr.title);
  if (!key) return null;
  const who = `PR #${pr.number} in ${repository.full_name} by ${pr.user.login}`;
  if ((action === "opened" || action === "reopened" || action === "ready_for_review") && !pr.draft) {
    return { key, sectionId: "review", reason: `${who} opened`, url: pr.html_url };
  }
  if (action === "closed" && pr.merged) {
    return { key, sectionId: "done", reason: `${who} merged`, url: pr.html_url };
  }
  return null;
}

/**
 * Remembers the last `capacity` delivery ids so a redelivered event is applied
 * once. GitHub resends on timeouts and 5xx. Bounded, so it cannot grow forever.
 */
export class RecentDeliveries {
  private readonly ids = new Set<string>();
  constructor(private readonly capacity = 1000) {}

  /** Records the id; returns false if it had already been seen. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }
}
