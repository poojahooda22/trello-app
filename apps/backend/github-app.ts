/**
 * Outbound GitHub calls, authenticated as the GitHub App installation.
 *
 * The App's private key signs a short JWT; GitHub exchanges that for an
 * installation token that expires in an hour. Tokens are cached until shortly
 * before they expire, so a burst of card writes is one token, not one each.
 */
import jwt from "jsonwebtoken";

// Overridable for GitHub Enterprise Server, and for tests that must not call
// the real API.
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const APP_ID = process.env.GITHUB_APP_ID;
// Stored with literal \n in .env, as GitHub hands the PEM out on one line.
const PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");

export const githubAppConfigured = Boolean(APP_ID && PRIVATE_KEY);
if (!githubAppConfigured) {
  console.warn(
    "GITHUB_APP_ID / GITHUB_PRIVATE_KEY not set — GitHub issues can be read from webhooks, " +
      "but the app cannot create or close them.",
  );
}

class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** Identifies the App itself. GitHub rejects anything older than 10 minutes. */
function appJwt(): string {
  if (!APP_ID || !PRIVATE_KEY) throw new Error("GitHub App credentials are not configured");
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: APP_ID }, PRIVATE_KEY, { algorithm: "RS256" });
}

const tokens = new Map<number, { token: string; expiresAt: number }>();

async function installationToken(installationId: number): Promise<string> {
  const cached = tokens.get(installationId);
  // A minute of headroom: a token that expires mid-request is a failed write.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await github(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    token: appJwt(),
  });
  const token = String(res.token);
  tokens.set(installationId, { token, expiresAt: new Date(String(res.expires_at)).getTime() });
  return token;
}

async function github(path: string, opts: { method?: string; token: string; body?: unknown }): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${opts.token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "trello-app",
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new GitHubError(res.status, `${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

/** The repositories an installation covers. Used to bind a repo to a board. */
export async function listInstallationRepos(installationId: number): Promise<{ fullName: string; id: number }[]> {
  const token = await installationToken(installationId);
  const res = await github("/installation/repositories?per_page=100", { token });
  return (res.repositories ?? []).map((r: any) => ({ fullName: r.full_name, id: r.id }));
}

/** Finds which installation covers a repository, so a board can be bound without a callback flow. */
export async function findInstallationForRepo(fullName: string): Promise<number | null> {
  const [ownerName, repoName] = fullName.split("/");
  if (!ownerName || !repoName) return null;
  const res = await github(`/repos/${ownerName}/${repoName}/installation`, { token: appJwt() });
  return typeof res?.id === "number" ? res.id : null;
}

export type GitHubIssue = { number: number; htmlUrl: string; title: string; state: "open" | "closed" };

const toIssue = (r: any): GitHubIssue => ({
  number: r.number,
  htmlUrl: r.html_url,
  title: r.title,
  state: r.state,
});

export async function createGitHubIssue(
  installationId: number,
  fullName: string,
  input: { title: string; body?: string },
): Promise<GitHubIssue> {
  const token = await installationToken(installationId);
  return toIssue(await github(`/repos/${fullName}/issues`, { method: "POST", token, body: input }));
}

export async function setGitHubIssueState(
  installationId: number,
  fullName: string,
  number: number,
  state: "open" | "closed",
): Promise<GitHubIssue> {
  const token = await installationToken(installationId);
  return toIssue(await github(`/repos/${fullName}/issues/${number}`, { method: "PATCH", token, body: { state } }));
}

/**
 * Deletes an issue for good. REST has no endpoint for this; it is a GraphQL
 * mutation, addressed by node id, so the number is resolved first. GitHub
 * grants deletion to the repository owner (personal) or admins (organization)
 * only — the caller must expect a refusal and decide what to do instead. An
 * issue that is already gone counts as deleted.
 *
 * GraphQL answers 200 with an `errors` array on refusal, so the status alone
 * says nothing. (On GitHub Enterprise Server the GraphQL endpoint is
 * /api/graphql rather than /api/v3/graphql; GITHUB_API_URL would need a
 * second setting to cover that.)
 */
export async function deleteGitHubIssue(installationId: number, fullName: string, number: number): Promise<void> {
  const token = await installationToken(installationId);
  let nodeId: string;
  try {
    const issue = await github(`/repos/${fullName}/issues/${number}`, { token });
    nodeId = String(issue.node_id);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return;
    throw err;
  }
  const res = await github("/graphql", {
    method: "POST",
    token,
    body: {
      query: "mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }",
      variables: { id: nodeId },
    },
  });
  const errors: { type?: string; message?: string }[] = Array.isArray(res?.errors) ? res.errors : [];
  if (errors.length === 0) return;
  // Gone between the lookup and the mutation: the outcome the caller wanted.
  if (errors.every((e) => e.type === "NOT_FOUND")) return;
  throw new GitHubError(403, errors.map((e) => e.message ?? e.type ?? "unknown error").join("; "));
}

export async function updateGitHubIssue(
  installationId: number,
  fullName: string,
  number: number,
  input: { title?: string; body?: string },
): Promise<GitHubIssue> {
  const token = await installationToken(installationId);
  return toIssue(await github(`/repos/${fullName}/issues/${number}`, { method: "PATCH", token, body: input }));
}

/** Open pull requests, for the board's repository panel. */
export async function listOpenPullRequests(
  installationId: number,
  fullName: string,
): Promise<{ number: number; title: string; htmlUrl: string; branch: string; author: string }[]> {
  const token = await installationToken(installationId);
  const res = await github(`/repos/${fullName}/pulls?state=open&per_page=50`, { token });
  return (res ?? []).map((p: any) => ({
    number: p.number,
    title: p.title,
    htmlUrl: p.html_url,
    branch: p.head?.ref ?? "",
    author: p.user?.login ?? "",
  }));
}
