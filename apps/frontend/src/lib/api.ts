// Bun substitutes this text with the value at bundle time (bunfig.toml:
// env = "BUN_PUBLIC_*"), so one image can be pointed at any backend. There is
// no runtime default to fall back to: if the variable is unset the reference
// survives into the browser, where `process` does not exist. src/index.ts
// refuses to start in that case, and .env supplies it in development.
const API_URL = process.env.BUN_PUBLIC_API_URL;

export type AuthResponse = {
  token: string;
  user: { id: string; email: string };
};

export async function signup(input: { email: string; password: string }): Promise<AuthResponse> {
  const res = await fetch(`${API_URL}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed with status ${res.status}`);
  }
  return res.json();
}


export async function signin(input: { email: string; password: string }): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `Request failed with status ${res.status}`);
    }
    return res.json();
  }


// --- Types the backend sends back -------------------------------------------
// JSON arrives untyped over HTTP, so the shapes the endpoints return are
// written out once here. These mirror the `select` in each backend handler.

export type Organization = { id: string; name: string; description: string | null; role: "ADMIN" | "MEMBER" };
export type Board = { id: string; title: string; organizationId: string };
export type SectionKind = "BACKLOG" | "TODO" | "INPROGRESS" | "REVIEW" | "DONE";
export type Issue = {
  id: string;
  key: string;
  number: number;
  title: string;
  description: string | null;
  position: number;
  sectionId: string;
  boardId: string;
  version: number;
  /** The GitHub issue this card mirrors, when the board has a linked repository. */
  githubNumber: number | null;
  priority: Priority | null;
  assignees: UserRef[];
  labels: Label[];
};

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const LABEL_COLORS = ["grey", "blue", "green", "yellow", "orange", "red", "purple"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];
export type Label = { id: string; name: string; color: string };
export type UserRef = { id: string; email: string };
export type Comment = { id: string; content: string; createdAt: string; user: UserRef };

/** Everything the issue detail page renders. */
export type IssueDetail = Issue & {
  section: { id: string; title: string; kind: SectionKind | null };
  comments: Comment[];
  organizationId: string;
  boardTitle: string;
  repository: string | null;
  githubUrl: string | null;
};
export type Section = { id: string; title: string; kind: SectionKind | null; position: number; issues: Issue[] };
export type BoardData = { roomToken: string; sections: Section[] };

/** Every authenticated endpoint needs this header — requireAuth 401s without it. */
function bearer() {
  return { Authorization: `Bearer ${localStorage.getItem("token")}` };
}

export async function me(): Promise<{ id: string; email: string }> {
  const res = await fetch(`${API_URL}/me`, { headers: bearer() });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed with status ${res.status}`);
  }
  return res.json();
}

export async function getOrganizations(): Promise<Organization[]> {
  const res = await fetch(`${API_URL}/organization`, { headers: bearer() });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed with status ${res.status}`);
  }
  return res.json();
}

export async function createOrganization(input: { name: string; description?: string }): Promise<Organization> {
  const res = await fetch(`${API_URL}/organization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed with status ${res.status}`);
  }
  return res.json();
}

export async function getBoards(orgId: string): Promise<Board[]> {
  const res = await fetch(`${API_URL}/boards?orgId=${orgId}`, { headers: bearer() });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed with status ${res.status}`);
  }
  return res.json();
}

/** Renames a board. The backend route is a PUT and replaces the title only. */
export async function updateBoard(boardId: string, input: { title: string }): Promise<Board> {
  const res = await fetch(`${API_URL}/board/${boardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...bearer() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed with status ${res.status}`);
  }
  return res.json();
}

export type InviteResult = {
  id: string;
  email: string;
  role: "ADMIN" | "MEMBER";
  expiresAt: string;
  emailed: boolean;
  emailError?: string;
  /** Only present when the mail did not go out, so the invite is still usable. */
  link?: string;
};

/**
 * Invites someone to the workspace an org owns. Membership is organization
 * scoped, so this grants access to every board in it, not to one board.
 * Requires the caller to be an admin of that organization.
 */
export async function inviteMember(input: {
  orgId: string;
  email: string;
  role?: "ADMIN" | "MEMBER";
}): Promise<InviteResult> {
  const res = await fetch(`${API_URL}/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed with status ${res.status}`);
  }
  return res.json();
}

export async function createBoard(input: { orgId: string; title: string }): Promise<Board> {
  const res = await fetch(`${API_URL}/boards`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed with status ${res.status}`);
  }
  return res.json();
}

async function request<T>(path: string, init: { method?: string; body?: string } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...bearer() },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    // Validation failures put the useful sentence in `details.fieldErrors`;
    // without it the user only ever sees "Invalid request body".
    const fieldErrors = body?.details?.fieldErrors as Record<string, string[]> | undefined;
    const detail = fieldErrors ? Object.values(fieldErrors).flat()[0] : undefined;
    const message = body?.error ?? `Request failed with status ${res.status}`;
    throw new Error(detail ? `${message}: ${detail}` : message);
  }
  return res.json();
}

/** The whole board in one round trip, plus the tab's room token for the socket relay. */
export const getSections = (boardId: string) => request<BoardData>(`/sections?boardId=${boardId}`);

export const createIssue = (input: { sectionId: string; title: string }) =>
  request<Issue>("/issue", { method: "POST", body: JSON.stringify(input) });

export const moveIssue = (input: { issueId: string; sectionId: string; position?: number }) =>
  request<Issue>("/issue/move", { method: "PUT", body: JSON.stringify(input) });

// --- Integrations -----------------------------------------------------------
// The provider credential never leaves the server; `hint` is a masked tail.

export type IntegrationProvider = "SLACK" | "GITHUB";
export type IntegrationStatus = {
  provider: IntegrationProvider;
  connected: boolean;
  enabled: boolean;
  label: string | null;
  hint: string | null;
  /** GitHub: "owner/repo". Slack: null — its identifier is the secret. */
  externalId: string | null;
  mirrorIssues: boolean;
  /** GitHub: false when the App is not installed there, so writes are impossible. */
  canWrite: boolean;
  lastEventAt: string | null;
  lastError: string | null;
};

export const getIntegrations = (boardId: string) => request<IntegrationStatus[]>(`/board/${boardId}/integrations`);

export const connectSlack = (boardId: string, input: { webhookUrl: string; label?: string }) =>
  request<IntegrationStatus[]>(`/board/${boardId}/integration/slack`, { method: "PUT", body: JSON.stringify(input) });

export const testSlack = (boardId: string) =>
  request<{ ok: boolean; error: string | null; integrations: IntegrationStatus[] }>(
    `/board/${boardId}/integration/slack/test`,
    { method: "POST" },
  );

export const setIntegrationEnabled = (boardId: string, provider: IntegrationProvider, enabled: boolean) =>
  request<IntegrationStatus[]>(`/board/${boardId}/integration/${provider}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });

export const disconnectIntegration = (boardId: string, provider: IntegrationProvider) =>
  request<IntegrationStatus[]>(`/board/${boardId}/integration/${provider}`, { method: "DELETE" });

/** Binds a repository to this board. `warning` explains any limitation (e.g. App not installed). */
export const connectGitHub = (boardId: string, input: { repository: string; mirrorIssues?: boolean }) =>
  request<{ integrations: IntegrationStatus[]; warning: string | null }>(`/board/${boardId}/integration/github`, {
    method: "PUT",
    body: JSON.stringify(input),
  });

/** Toggles mirroring alone — it must not re-run repository binding. */
export const setMirrorIssues = (boardId: string, mirrorIssues: boolean) =>
  request<IntegrationStatus[]>(`/board/${boardId}/integration/github/mirror`, {
    method: "PATCH",
    body: JSON.stringify({ mirrorIssues }),
  });

export type PullRequestSummary = { number: number; title: string; htmlUrl: string; branch: string; author: string };

export const getPullRequests = (boardId: string) =>
  request<{ repository: string | null; pulls: PullRequestSummary[] }>(`/board/${boardId}/github/pulls`);

/** Pushes an existing card to GitHub as an issue. */
export const pushCardToGitHub = (issueId: string) =>
  request<{ issue: Issue; url: string }>(`/issue/${issueId}/github`, { method: "POST" });

// --- Issue detail ------------------------------------------------------------

export const getIssue = (issueId: string) => request<IssueDetail>(`/issue/${issueId}`);

export const updateIssue = (
  issueId: string,
  input: { title?: string; description?: string | null; priority?: Priority | null },
) => request<Issue>(`/issue/${issueId}`, { method: "PUT", body: JSON.stringify(input) });

export const deleteIssue = (issueId: string) =>
  fetch(`${API_URL}/issue/${issueId}`, { method: "DELETE", headers: bearer() }).then((res) => {
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  });

export const addAssignee = (issueId: string, userId: string) =>
  request<Issue>(`/issue/${issueId}/assignee`, { method: "POST", body: JSON.stringify({ userId }) });

export const removeAssignee = (issueId: string, userId: string) =>
  request<Issue>(`/issue/${issueId}/assignee/${userId}`, { method: "DELETE" });

export const getLabels = (boardId: string) => request<Label[]>(`/board/${boardId}/labels`);

export const createLabel = (boardId: string, input: { name: string; color?: LabelColor }) =>
  request<Label>(`/board/${boardId}/label`, { method: "POST", body: JSON.stringify(input) });

export const addLabel = (issueId: string, labelId: string) =>
  request<Issue>(`/issue/${issueId}/label`, { method: "POST", body: JSON.stringify({ labelId }) });

export const removeLabel = (issueId: string, labelId: string) =>
  request<Issue>(`/issue/${issueId}/label/${labelId}`, { method: "DELETE" });

export type OrgMember = { id: string; email: string; role: "ADMIN" | "MEMBER" };

export const getMembers = (orgId: string) => request<OrgMember[]>(`/organization/${orgId}/members`);

export const addComment = (issueId: string, content: string) =>
  request<Comment>("/comment", { method: "POST", body: JSON.stringify({ issueId, content }) });
