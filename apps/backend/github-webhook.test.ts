import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  RecentDeliveries,
  findIssueKey,
  planMoveForPullRequest,
  pullRequestEvent,
  verifyGitHubSignature,
} from "./github-webhook";
import { canMove, keyPrefixFor, parseIssueKey } from "./board-rules";
import { parseRepoInput } from "./integrations";

const sign = (secret: string, body: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe("verifyGitHubSignature", () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  test("accepts the correct signature", () => {
    expect(verifyGitHubSignature("s3cret", body, sign("s3cret", body.toString()))).toBe(true);
  });
  test("rejects a wrong secret, a tampered body, a missing header, and a wrong scheme", () => {
    expect(verifyGitHubSignature("other", body, sign("s3cret", body.toString()))).toBe(false);
    expect(verifyGitHubSignature("s3cret", Buffer.from(body.toString() + " "), sign("s3cret", body.toString()))).toBe(false);
    expect(verifyGitHubSignature("s3cret", body, undefined)).toBe(false);
    expect(verifyGitHubSignature("s3cret", body, "sha1=abc")).toBe(false);
    expect(verifyGitHubSignature("s3cret", body, "sha256=abc")).toBe(false);
  });
});

describe("board-rules", () => {
  test("keyPrefixFor derives a 3-letter prefix and falls back for short titles", () => {
    expect(keyPrefixFor("Zepto Board")).toBe("ZEP");
    expect(keyPrefixFor("google board")).toBe("GOO");
    expect(keyPrefixFor("  a ")).toBe("BRD");
    expect(keyPrefixFor("Q3")).toBe("Q3");
  });
  test("keyPrefixFor strips leading digits so the key parser can read the result", () => {
    expect(keyPrefixFor("3D Assets")).toBe("DAS");
    expect(keyPrefixFor("2048 game")).toBe("GAM");
    expect(keyPrefixFor("123")).toBe("BRD");
  });
  test("parseIssueKey reads any prefix and ignores look-alikes", () => {
    expect(parseIssueKey("feat/zep-7-login")).toEqual({ prefix: "ZEP", number: 7 });
    expect(parseIssueKey("Fix GOO2-12 now")).toEqual({ prefix: "GOO2", number: 12 });
    expect(parseIssueKey("main")).toBeNull();
    expect(parseIssueKey("ZEP-")).toBeNull();
    expect(parseIssueKey(undefined)).toBeNull();
  });
  // The table was deliberately loosened: a card may go anywhere except back out
  // of DONE, which stays one-way. This mirrors apps/frontend/src/lib/board.ts —
  // the two must agree or the client places a card the server then rejects.
  test("canMove allows any transition except out of DONE, and frees custom columns", () => {
    expect(canMove("TODO", "INPROGRESS")).toBe(true);
    expect(canMove("TODO", "DONE")).toBe(true);
    expect(canMove("BACKLOG", "REVIEW")).toBe(true);
    expect(canMove("REVIEW", "BACKLOG")).toBe(true);
    expect(canMove("DONE", "TODO")).toBe(false);
    expect(canMove("DONE", "REVIEW")).toBe(false);
    expect(canMove("REVIEW", "REVIEW")).toBe(true);
    expect(canMove("DONE", "DONE")).toBe(true);
    expect(canMove(null, "DONE")).toBe(true);
    expect(canMove("DONE", null)).toBe(true);
  });
});

describe("findIssueKey", () => {
  test("finds the key in a branch name or title; first text wins", () => {
    expect(findIssueKey("feat/ZEP-42-github-integration")).toBe("ZEP-42");
    expect(findIssueKey("feature/goo-7", "ZEP-9 title")).toBe("GOO-7");
    expect(findIssueKey("main", "Fix login (ZEP-3)")).toBe("ZEP-3");
    expect(findIssueKey("main", "no key here")).toBeNull();
  });
});

function event(overrides: Record<string, unknown> = {}) {
  return pullRequestEvent.parse({
    action: "opened",
    pull_request: {
      number: 12,
      title: "Add GitHub integration",
      html_url: "https://github.com/pooja/trello-app/pull/12",
      merged: false,
      draft: false,
      head: { ref: "feat/ZEP-1-github" },
      user: { login: "poojahooda22" },
      extra_field_from_github: "ignored",
    },
    repository: { full_name: "pooja/trello-app" },
    ...overrides,
  });
}

describe("planMoveForPullRequest", () => {
  test("opened / reopened / ready_for_review → REVIEW", () => {
    for (const action of ["opened", "reopened", "ready_for_review"]) {
      expect(planMoveForPullRequest(event({ action }))).toMatchObject({ key: "ZEP-1", kind: "REVIEW" });
    }
  });
  test("draft opened → nothing", () => {
    const e = event();
    e.pull_request.draft = true;
    expect(planMoveForPullRequest(e)).toBeNull();
  });
  test("closed + merged → DONE; closed unmerged → nothing", () => {
    const merged = event({ action: "closed" });
    merged.pull_request.merged = true;
    expect(planMoveForPullRequest(merged)).toMatchObject({ key: "ZEP-1", kind: "DONE" });
    expect(planMoveForPullRequest(event({ action: "closed" }))).toBeNull();
  });
  test("no key → nothing", () => {
    const noKey = event();
    noKey.pull_request.head.ref = "main";
    noKey.pull_request.title = "untracked change";
    expect(planMoveForPullRequest(noKey)).toBeNull();
  });
});

describe("RecentDeliveries", () => {
  test("first sight true, repeat false, oldest evicted past capacity", () => {
    const seen = new RecentDeliveries(2);
    expect(seen.add("a")).toBe(true);
    expect(seen.add("a")).toBe(false);
    seen.add("b");
    seen.add("c");
    expect(seen.add("a")).toBe(true);
    expect(seen.add("c")).toBe(false);
  });
});

describe("parseRepoInput", () => {
  test("accepts owner/repo and every shape a pasted GitHub URL takes", () => {
    expect(parseRepoInput("owner/repo")).toBe("owner/repo");
    expect(parseRepoInput("https://github.com/owner/repo")).toBe("owner/repo");
    expect(parseRepoInput("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseRepoInput("https://github.com/owner/repo/tree/main")).toBe("owner/repo");
    expect(parseRepoInput("github.com/owner/repo/")).toBe("owner/repo");
    expect(parseRepoInput("www.github.com/owner/repo")).toBe("owner/repo");
  });
  test("rejects other hosts and non-repo strings", () => {
    expect(parseRepoInput("https://gitlab.com/owner/repo")).toBeNull();
    expect(parseRepoInput("not a repo")).toBeNull();
    expect(parseRepoInput("https://github.com/onlyowner")).toBeNull();
    expect(parseRepoInput("")).toBeNull();
  });
});
