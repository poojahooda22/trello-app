const API_URL = "http://localhost:3001";

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
