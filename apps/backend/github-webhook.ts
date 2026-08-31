/**
 * GitHub webhook handling: the pure parts. No Express, no network — the route
 * in index.ts wires these to HTTP, and they can be tested without a server.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { issueKey, parseIssueKey } from "./board-rules";

/** True when `X-Hub-Signature-256` equals HMAC-SHA256(secret, rawBody), compared in constant time. */
export function verifyGitHubSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const received = Buffer.from(signatureHeader.slice("sha256=".length));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** The first card key (e.g. ZEP-7) found in any of the texts — branch name, PR title — upper-cased. */
export function findIssueKey(...texts: (string | undefined)[]): string | null {
  for (const text of texts) {
    const parsed = parseIssueKey(text);
    if (parsed) return issueKey(parsed.prefix, parsed.number);
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

// GitHub issues mirrored as cards. Only the fields the handler reads.
export const issuesEvent = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string(),
    state: z.string(),
    user: z.object({ login: z.string() }),
  }),
  repository: z.object({ full_name: z.string() }),
  sender: z.object({ login: z.string(), type: z.string() }).optional(),
  // On an edit GitHub names the fields that actually changed. Without this we
  // would write the whole payload back and revert edits made on the board.
  changes: z.object({ title: z.unknown().optional(), body: z.unknown().optional() }).optional(),
});
export type IssuesEvent = z.infer<typeof issuesEvent>;

/** What an `issues` event should do to the board, or null to ignore it. */
export type IssuePlan =
  | { type: "create"; number: number; title: string; body: string | null; url: string; author: string }
  | { type: "state"; number: number; kind: "TODO" | "DONE"; reason: string }
  | { type: "edit"; number: number; title: string; body: string | null; changedTitle: boolean; changedBody: boolean }
  | { type: "delete"; number: number };

export function planForIssue(event: IssuesEvent): IssuePlan | null {
  const { action, issue, repository } = event;
  const who = `issue #${issue.number} in ${repository.full_name}`;
  switch (action) {
    case "opened":
      return {
        type: "create",
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        url: issue.html_url,
        author: issue.user.login,
      };
    case "closed":
      return { type: "state", number: issue.number, kind: "DONE", reason: `${who} closed` };
    case "reopened":
      return { type: "state", number: issue.number, kind: "TODO", reason: `${who} reopened` };
    case "edited":
      return {
        type: "edit",
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        changedTitle: event.changes?.title !== undefined,
        changedBody: event.changes?.body !== undefined,
      };
    case "deleted":
      return { type: "delete", number: issue.number };
    default:
      return null; // labeled, assigned, milestoned… nothing to mirror yet
  }
}

export type CardMove = { key: string; kind: "REVIEW" | "DONE"; reason: string; url: string };

/**
 * What a pull_request event should do to the board, or null to ignore it.
 *   opened / reopened / ready_for_review (not a draft) → REVIEW
 *   closed with merged: true                           → DONE
 */
export function planMoveForPullRequest(event: PullRequestEvent): CardMove | null {
  const { action, pull_request: pr, repository } = event;
  const key = findIssueKey(pr.head.ref, pr.title);
  if (!key) return null;
  const who = `PR #${pr.number} in ${repository.full_name} by ${pr.user.login}`;
  if ((action === "opened" || action === "reopened" || action === "ready_for_review") && !pr.draft) {
    return { key, kind: "REVIEW", reason: `${who} opened`, url: pr.html_url };
  }
  if (action === "closed" && pr.merged) {
    return { key, kind: "DONE", reason: `${who} merged`, url: pr.html_url };
  }
  return null;
}

/** Remembers the last `capacity` delivery ids so a redelivered event is applied once. Bounded. */
export class RecentDeliveries {
  private readonly ids = new Set<string>();
  constructor(private readonly capacity = 1000) {}

  /** Forgets an id so the redelivery of a failed event is processed again. */
  forget(id: string): void {
    this.ids.delete(id);
  }

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
