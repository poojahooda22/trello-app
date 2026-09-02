import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { API_URL } from "./env";

/**
 * Fixtures every spec builds on.
 *
 * Setup happens over HTTP, not through the UI. Signing up and creating a board
 * by clicking takes about eight seconds and re-tests the same two screens in
 * every file; the API does it in one round trip. What the spec is actually
 * about is then the only thing driven through the browser.
 *
 * Each test gets its own user, organization and board. The suite runs
 * fullyParallel against one database, so shared rows would make specs able to
 * see — and delete — each other's data.
 */

export type SectionKind = "BACKLOG" | "TODO" | "INPROGRESS" | "REVIEW" | "DONE";

export type TestUser = {
  id: string;
  email: string;
  password: string;
  /** The JWT the app keeps in localStorage under "token". */
  token: string;
};

export type Section = {
  id: string;
  title: string;
  kind: SectionKind | null;
  position: number;
  issues: Issue[];
};

export type Issue = {
  id: string;
  key: string;
  number: number;
  title: string;
  sectionId: string;
  boardId: string;
  position: number;
  version: number;
  priority: string | null;
  labels: { id: string; name: string; color: string }[];
  assignees: { id: string; email: string }[];
};

export type TestBoard = {
  id: string;
  title: string;
  organizationId: string;
  /** The five default columns, in board order. */
  sections: Section[];
  /** Looks a column up by kind — `section("DONE").id` rather than an index. */
  section: (kind: SectionKind) => Section;
};

/** A signed-in HTTP client for one user. Mirrors what the app's fetch wrapper sends. */
export class ApiClient {
  constructor(
    private readonly request: APIRequestContext,
    readonly token: string,
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }

  /** Throws with the server's message rather than a bare status, so a failed
   *  setup step names its own cause instead of surfacing later as a missing element. */
  private async json<T>(res: Awaited<ReturnType<APIRequestContext["post"]>>, what: string): Promise<T> {
    if (!res.ok()) {
      const body = await res.text();
      throw new Error(`${what} failed: ${res.status()} ${body}`);
    }
    return (await res.json()) as T;
  }

  async createOrganization(name: string) {
    const res = await this.request.post(`${API_URL}/organization`, {
      headers: this.headers(),
      data: { name },
    });
    return this.json<{ id: string; name: string }>(res, "createOrganization");
  }

  async createBoard(orgId: string, title: string) {
    const res = await this.request.post(`${API_URL}/boards`, {
      headers: this.headers(),
      data: { orgId, title },
    });
    return this.json<{ id: string; title: string; organizationId: string }>(res, "createBoard");
  }

  async getSections(boardId: string) {
    const res = await this.request.get(`${API_URL}/sections?boardId=${boardId}`, { headers: this.headers() });
    return this.json<{ roomToken: string; sections: Section[] }>(res, "getSections");
  }

  async createIssue(sectionId: string, title: string) {
    const res = await this.request.post(`${API_URL}/issue`, {
      headers: this.headers(),
      data: { sectionId, title },
    });
    return this.json<Issue>(res, "createIssue");
  }

  async moveIssue(issueId: string, sectionId: string, position?: number) {
    const res = await this.request.put(`${API_URL}/issue/move`, {
      headers: this.headers(),
      data: position === undefined ? { issueId, sectionId } : { issueId, sectionId, position },
    });
    return res;
  }

  async createLabel(boardId: string, name: string, color = "blue") {
    const res = await this.request.post(`${API_URL}/board/${boardId}/label`, {
      headers: this.headers(),
      data: { name, color },
    });
    return this.json<{ id: string; name: string; color: string }>(res, "createLabel");
  }

  async addLabel(issueId: string, labelId: string) {
    const res = await this.request.post(`${API_URL}/issue/${issueId}/label`, {
      headers: this.headers(),
      data: { labelId },
    });
    return this.json<Issue>(res, "addLabel");
  }

  async updateIssue(issueId: string, input: Record<string, unknown>) {
    const res = await this.request.put(`${API_URL}/issue/${issueId}`, { headers: this.headers(), data: input });
    return this.json<Issue>(res, "updateIssue");
  }

  async addComment(issueId: string, content: string) {
    const res = await this.request.post(`${API_URL}/comment`, {
      headers: this.headers(),
      data: { issueId, content },
    });
    return this.json<{ id: string; content: string }>(res, "addComment");
  }

  async invite(orgId: string, email: string, role: "ADMIN" | "MEMBER" = "MEMBER") {
    const res = await this.request.post(`${API_URL}/invite`, {
      headers: this.headers(),
      data: { orgId, email, role },
    });
    return res;
  }

  /** Raw escape hatch for specs asserting on status codes and error bodies. */
  raw() {
    return { request: this.request, headers: this.headers() };
  }
}

/** Signs up a brand-new user. The email is a fresh uuid, so parallel workers never collide. */
export async function signUp(request: APIRequestContext): Promise<TestUser> {
  const email = `e2e-${randomUUID()}@example.test`;
  // The backend's zod schema demands at least 8 characters.
  const password = "e2e-password-1234";
  const res = await request.post(`${API_URL}/signup`, { data: { email, password } });
  if (!res.ok()) throw new Error(`signup failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { token: string; user: { id: string; email: string } };
  return { id: body.user.id, email, password, token: body.token };
}

/**
 * Puts the JWT where the app looks for it before any of its own code runs.
 * lib/api.ts reads localStorage.getItem("token") on every authenticated call,
 * so a page opened after this is already signed in and never sees /signin.
 */
export async function authenticate(page: Page, token: string): Promise<void> {
  await page.addInitScript((value) => {
    window.localStorage.setItem("token", value);
  }, token);
}

type Fixtures = {
  /** An unauthenticated HTTP client — for signup, signin and 401 assertions. */
  anon: APIRequestContext;
  user: TestUser;
  api: ApiClient;
  org: { id: string; name: string };
  board: TestBoard;
  /** A second user in the same organization, for permission and realtime specs. */
  teammate: { user: TestUser; api: ApiClient };
};

export const test = base.extend<Fixtures>({
  anon: async ({ request }, use) => {
    await use(request);
  },

  user: async ({ request }, use) => {
    await use(await signUp(request));
  },

  api: async ({ request, user }, use) => {
    await use(new ApiClient(request, user.token));
  },

  org: async ({ api }, use) => {
    await use(await api.createOrganization(`E2E Org ${randomUUID().slice(0, 8)}`));
  },

  board: async ({ api, org }, use) => {
    // "Zepto Board" -> keyPrefix "ZEP". A fixed title keeps the card keys the
    // specs assert on predictable.
    const created = await api.createBoard(org.id, "Zepto Board");
    const { sections } = await api.getSections(created.id);
    await use({
      ...created,
      sections,
      section: (kind) => {
        const found = sections.find((s) => s.kind === kind);
        if (!found) throw new Error(`board has no ${kind} column; got ${sections.map((s) => s.kind).join(", ")}`);
        return found;
      },
    });
  },

  teammate: async ({ request, org, api }, use) => {
    const second = await signUp(request);
    // Invite, then accept as the invited user, so the teammate reaches the
    // board the same way a real one does.
    const invited = await api.invite(org.id, second.email);
    if (!invited.ok()) throw new Error(`invite failed: ${invited.status()} ${await invited.text()}`);
    const { link } = (await invited.json()) as { link?: string };
    const token = link ? new URL(link).searchParams.get("token") : null;
    if (!token) throw new Error("invite response carried no usable link — is RESEND_API_KEY set in the E2E env?");
    const accepted = await request.post(`${API_URL}/accept`, {
      headers: { Authorization: `Bearer ${second.token}`, "Content-Type": "application/json" },
      data: { token },
    });
    if (!accepted.ok()) throw new Error(`accept failed: ${accepted.status()} ${await accepted.text()}`);
    await use({ user: second, api: new ApiClient(request, second.token) });
  },

  // Every spec that uses `page` gets it already signed in as `user`.
  page: async ({ page, user }, use) => {
    await authenticate(page, user.token);
    await use(page);
  },
});

export { expect };
