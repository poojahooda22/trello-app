import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Resend } from "resend";
import { prisma } from "db/client";
import {
  RecentDeliveries,
  planMoveForPullRequest,
  pullRequestEvent,
  verifyGitHubSignature,
  type CardMove,
} from "./github-webhook";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Fail at boot, not on the first request that needs the value. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Add it to apps/backend/.env before starting.`);
    process.exit(1);
  }
  return value;
}

const JWT_SECRET = requireEnv("JWT_SECRET");
const PORT = Number(process.env.PORT ?? 3000);
const APP_URL = process.env.APP_URL ?? "http://localhost:5173";
const INVITE_FROM = process.env.INVITE_FROM ?? "onboarding@resend.dev";
const TOKEN_TTL = "7d";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// GitHub App webhook secret (set the same value on the App's settings page) and
// the socket server's internal endpoint, which owns the in-memory board today.
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const WS_INTERNAL_URL = process.env.WS_INTERNAL_URL ?? "http://localhost:3003";
const WS_INTERNAL_TOKEN = process.env.WS_INTERNAL_TOKEN;
if (!GITHUB_WEBHOOK_SECRET) {
  console.warn("GITHUB_WEBHOOK_SECRET not set — POST /webhooks/github answers 503 until it is.");
}
if (!WS_INTERNAL_TOKEN) {
  console.warn("WS_INTERNAL_TOKEN not set — GitHub events cannot reach the socket server.");
}

// Gaps between positions are deliberate: dropping a card between two others is
// one UPDATE to the midpoint instead of renumbering every row below it.
const POSITION_GAP = 1000;

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (!resend) {
  console.warn("RESEND_API_KEY not set — POST /invite will return the invite link instead of emailing it.");
}

type Role = "ADMIN" | "MEMBER";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

declare module "http" {
  interface IncomingMessage {
    /** The exact bytes received; webhook signatures are computed over these. */
    rawBody?: Buffer;
  }
}

// ---------------------------------------------------------------------------
// Errors and validation
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Validate untrusted input at the boundary. Anything malformed fails as a 400. */
function parse<T extends z.ZodType>(schema: T, data: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, `Invalid request ${what}`, z.flattenError(result.error));
  }
  return result.data;
}

/**
 * Narrows req.userId without a cast. requireAuth always sets it before any
 * handler runs, so this throwing means a route was mounted unguarded.
 */
function auth(req: Request): string {
  if (!req.userId) throw new HttpError(401, "Authentication required");
  return req.userId;
}

function signToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Missing Bearer token");

  let payload: unknown;
  try {
    payload = jwt.verify(header.slice("Bearer ".length), JWT_SECRET);
  } catch {
    throw new HttpError(401, "Invalid or expired token");
  }

  if (typeof payload !== "object" || payload === null || !("userId" in payload)) {
    throw new HttpError(401, "Malformed token payload");
  }
  const { userId } = payload;
  if (typeof userId !== "string") throw new HttpError(401, "Malformed token payload");

  req.userId = userId;
  next();
}

/** User-controlled text goes into invite emails; escape it before interpolating. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Authorization
//
// Every route below answers "is this user a member of the org that owns this
// row?", not merely "is someone logged in". Without that check any signed-in
// user could read another organization's boards by guessing a uuid.
// ---------------------------------------------------------------------------

/**
 * A non-member gets 404, never 403 — a 403 would confirm that the id exists
 * and leak the shape of other organizations.
 */
async function requireMember(
  userId: string,
  orgId: string,
  opts: { admin?: boolean } = {},
): Promise<{ id: string; role: Role }> {
  const member = await prisma.member.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { id: true, role: true },
  });
  if (!member) throw new HttpError(404, "Not found");
  if (opts.admin && member.role !== "ADMIN") throw new HttpError(403, "Admin role required");
  return member;
}

async function orgOfBoard(boardId: string): Promise<string> {
  const board = await prisma.board.findUnique({
    where: { id: boardId },
    select: { organizationId: true },
  });
  if (!board) throw new HttpError(404, "Not found");
  return board.organizationId;
}

async function orgOfSection(sectionId: string): Promise<string> {
  const section = await prisma.section.findUnique({
    where: { id: sectionId },
    select: { board: { select: { organizationId: true } } },
  });
  if (!section) throw new HttpError(404, "Not found");
  return section.board.organizationId;
}

async function orgOfIssue(issueId: string): Promise<string> {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { section: { select: { board: { select: { organizationId: true } } } } },
  });
  if (!issue) throw new HttpError(404, "Not found");
  return issue.section.board.organizationId;
}

/** Append position: one past the last row, or the first gap if the list is empty. */
async function nextSectionPosition(boardId: string): Promise<number> {
  const last = await prisma.section.findFirst({
    where: { boardId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (last?.position ?? 0) + POSITION_GAP;
}

async function nextIssuePosition(sectionId: string): Promise<number> {
  const last = await prisma.issue.findFirst({
    where: { sectionId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (last?.position ?? 0) + POSITION_GAP;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const credentials = z.object({
  email: z.email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const roleSchema = z.enum(["ADMIN", "MEMBER"]);
const title = z.string().min(1).max(200);

const orgIdParam = z.object({ orgId: z.uuid() });
const boardIdParam = z.object({ boardId: z.uuid() });
const sectionIdParam = z.object({ sectionId: z.uuid() });
const issueIdParam = z.object({ issueId: z.uuid() });
const commentIdParam = z.object({ commentId: z.uuid() });

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(cors({ origin: APP_URL }));
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// --- Auth -------------------------------------------------------------------

app.post("/signup", async (req, res) => {
  const { email, password } = parse(credentials, req.body, "body");

  const user = await prisma.user.create({
    // Bun.password.hash is argon2id by default — no bcrypt dependency needed.
    data: { email, passwordHash: await Bun.password.hash(password) },
    select: { id: true, email: true },
  });

  res.status(201).json({ token: signToken(user.id), user });
});

app.post("/signin", async (req, res) => {
  const { email, password } = parse(credentials, req.body, "body");

  const user = await prisma.user.findUnique({ where: { email } });
  // One message for both failure modes, so this endpoint cannot be used to
  // enumerate which email addresses have accounts.
  if (!user || !(await Bun.password.verify(password, user.passwordHash))) {
    throw new HttpError(401, "Invalid email or password");
  }

  res.json({ token: signToken(user.id), user: { id: user.id, email: user.email } });
});

app.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: auth(req) },
    select: {
      id: true,
      email: true,
      memberships: {
        select: { role: true, org: { select: { id: true, name: true, description: true } } },
      },
    },
  });
  if (!user) throw new HttpError(404, "Not found");

  res.json({
    id: user.id,
    email: user.email,
    organizations: user.memberships.map((m) => ({ ...m.org, role: m.role })),
  });
});

// --- Organizations ----------------------------------------------------------

app.post("/organization", requireAuth, async (req, res) => {
  const userId = auth(req);
  const { name, description } = parse(
    z.object({ name: title, description: z.string().max(2000).optional() }),
    req.body,
    "body",
  );

  // Nested create: the org and its creator's ADMIN membership land in one
  // transaction, so an org can never exist with nobody able to administer it.
  const org = await prisma.organization.create({
    data: { name, description, members: { create: { userId, role: "ADMIN" } } },
    select: { id: true, name: true, description: true },
  });

  res.status(201).json({ ...org, role: "ADMIN" satisfies Role });
});

app.get("/organization", requireAuth, async (req, res) => {
  const rows = await prisma.member.findMany({
    where: { userId: auth(req) },
    select: { role: true, org: { select: { id: true, name: true, description: true } } },
  });
  res.json(rows.map((r) => ({ ...r.org, role: r.role })));
});

app.get("/organization/:orgId/members", requireAuth, async (req, res) => {
  const { orgId } = parse(orgIdParam, req.params, "URL parameters");
  await requireMember(auth(req), orgId);

  const members = await prisma.member.findMany({
    where: { orgId },
    select: { id: true, role: true, user: { select: { id: true, email: true } } },
  });
  res.json(members);
});

app.delete("/organization/:orgId", requireAuth, async (req, res) => {
  const { orgId } = parse(orgIdParam, req.params, "URL parameters");
  await requireMember(auth(req), orgId, { admin: true });

  // Cascades through members, boards, sections, issues and comments.
  await prisma.organization.delete({ where: { id: orgId } });
  res.status(204).end();
});

// --- Invitations and membership --------------------------------------------

app.post("/invite", requireAuth, async (req, res) => {
  const { email, orgId, role } = parse(
    z.object({ email: z.email(), orgId: z.uuid(), role: roleSchema.default("MEMBER") }),
    req.body,
    "body",
  );
  await requireMember(auth(req), orgId, { admin: true });

  const invitee = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (invitee) {
    const existing = await prisma.member.findUnique({
      where: { userId_orgId: { userId: invitee.id, orgId } },
      select: { id: true },
    });
    if (existing) throw new HttpError(409, "That user is already a member of this organization");
  }

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { name: true },
  });
  if (!org) throw new HttpError(404, "Not found");

  const invite = await prisma.invite.create({
    // 32 random bytes: the token is the only secret protecting /accept.
    data: {
      email,
      orgId,
      role,
      token: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
    select: { id: true, email: true, role: true, expiresAt: true, token: true },
  });

  const link = `${APP_URL}/accept-invite?token=${invite.token}`;

  let emailed = false;
  let emailError: string | null = null;
  if (resend) {
    const { error } = await resend.emails.send({
      from: INVITE_FROM,
      to: email,
      subject: `You have been invited to ${org.name}`,
      html:
        `<p>You have been invited to join <strong>${escapeHtml(org.name)}</strong> on Trello.</p>` +
        `<p><a href="${link}">Accept the invitation</a></p>` +
        `<p>This link expires in 7 days.</p>`,
    });
    if (error) emailError = error.message;
    else emailed = true;
  }

  res.status(201).json({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
    emailed,
    ...(emailError ? { emailError } : {}),
    // Only surfaced when the mail did not go out, so the flow stays usable
    // before RESEND_API_KEY is configured.
    ...(emailed ? {} : { link }),
  });
});

app.post("/accept", requireAuth, async (req, res) => {
  const userId = auth(req);
  const { token } = parse(z.object({ token: z.string().min(1) }), req.body, "body");

  const invite = await prisma.invite.findUnique({ where: { token } });
  if (!invite) throw new HttpError(404, "Invitation not found");
  if (invite.acceptedAt) throw new HttpError(409, "That invitation has already been used");
  if (invite.expiresAt < new Date()) throw new HttpError(410, "That invitation has expired");

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new HttpError(404, "Not found");

  // The invite is bound to the address it was issued to: forwarding the link
  // to someone else does not let them redeem it.
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new HttpError(403, "This invitation was issued to a different email address");
  }

  const member = await prisma.$transaction(async (tx) => {
    // Guarded write: claim the invite by updating only rows still unaccepted
    // and checking the row count. Two concurrent accepts, one winner.
    const claimed = await tx.invite.updateMany({
      where: { id: invite.id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count === 0) throw new HttpError(409, "That invitation has already been used");

    return tx.member.create({
      data: { userId, orgId: invite.orgId, role: invite.role },
      select: { id: true, role: true, orgId: true },
    });
  });

  res.status(201).json(member);
});

app.delete("/membership", requireAuth, async (req, res) => {
  const callerId = auth(req);
  const { userId, orgId } = parse(
    z.object({ userId: z.uuid(), orgId: z.uuid() }),
    req.body,
    "body",
  );

  const caller = await requireMember(callerId, orgId);
  // Anyone may remove themselves; removing someone else requires ADMIN.
  if (userId !== callerId && caller.role !== "ADMIN") {
    throw new HttpError(403, "Admin role required");
  }

  const target = await prisma.member.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { id: true, role: true },
  });
  if (!target) throw new HttpError(404, "Not found");

  if (target.role === "ADMIN") {
    const admins = await prisma.member.count({ where: { orgId, role: "ADMIN" } });
    // Refuse to strand an organization with nobody able to administer it.
    if (admins <= 1) throw new HttpError(409, "Cannot remove the last admin of an organization");
  }

  await prisma.member.delete({ where: { id: target.id } });
  res.status(204).end();
});

// --- Boards -----------------------------------------------------------------

app.get("/boards", requireAuth, async (req, res) => {
  const { orgId } = parse(orgIdParam, req.query, "query");
  await requireMember(auth(req), orgId);

  const boards = await prisma.board.findMany({
    where: { organizationId: orgId },
    select: { id: true, title: true, organizationId: true },
  });
  res.json(boards);
});

app.post("/boards", requireAuth, async (req, res) => {
  const body = parse(z.object({ orgId: z.uuid(), title }), req.body, "body");
  await requireMember(auth(req), body.orgId);

  const board = await prisma.board.create({
    data: { title: body.title, organizationId: body.orgId },
    select: { id: true, title: true, organizationId: true },
  });
  res.status(201).json(board);
});

app.put("/board/:boardId", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  const body = parse(z.object({ title }), req.body, "body");
  await requireMember(auth(req), await orgOfBoard(boardId));

  const board = await prisma.board.update({
    where: { id: boardId },
    data: { title: body.title },
    select: { id: true, title: true, organizationId: true },
  });
  res.json(board);
});

app.delete("/board/:boardId", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfBoard(boardId), { admin: true });

  await prisma.board.delete({ where: { id: boardId } });
  res.status(204).end();
});

// --- Sections ---------------------------------------------------------------

app.get("/sections", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.query, "query");
  await requireMember(auth(req), await orgOfBoard(boardId));

  // Issues are nested so the whole board renders from one round trip.
  const sections = await prisma.section.findMany({
    where: { boardId },
    orderBy: { position: "asc" },
    select: {
      id: true,
      title: true,
      position: true,
      issues: {
        orderBy: { position: "asc" },
        select: { id: true, title: true, description: true, position: true },
      },
    },
  });
  res.json(sections);
});

app.post("/section", requireAuth, async (req, res) => {
  const body = parse(z.object({ boardId: z.uuid(), title }), req.body, "body");
  await requireMember(auth(req), await orgOfBoard(body.boardId));

  const section = await prisma.section.create({
    data: {
      boardId: body.boardId,
      title: body.title,
      position: await nextSectionPosition(body.boardId),
    },
    select: { id: true, title: true, boardId: true, position: true },
  });
  res.status(201).json(section);
});

app.put("/section/:sectionId", requireAuth, async (req, res) => {
  const { sectionId } = parse(sectionIdParam, req.params, "URL parameters");
  const body = parse(
    z
      .object({ title: title.optional(), position: z.number().optional() })
      .refine((v) => v.title !== undefined || v.position !== undefined, {
        message: "Provide at least one of title or position",
      }),
    req.body,
    "body",
  );
  await requireMember(auth(req), await orgOfSection(sectionId));

  const section = await prisma.section.update({
    where: { id: sectionId },
    data: { title: body.title, position: body.position },
    select: { id: true, title: true, boardId: true, position: true },
  });
  res.json(section);
});

app.delete("/section/:sectionId", requireAuth, async (req, res) => {
  const { sectionId } = parse(sectionIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfSection(sectionId));

  // Cascades to the issues in the column.
  await prisma.section.delete({ where: { id: sectionId } });
  res.status(204).end();
});

// --- Issues -----------------------------------------------------------------

app.get("/issues", requireAuth, async (req, res) => {
  const userId = auth(req);
  const { sectionId, boardId } = parse(
    z
      .object({ sectionId: z.uuid().optional(), boardId: z.uuid().optional() })
      .refine((q) => Boolean(q.sectionId) !== Boolean(q.boardId), {
        message: "Provide exactly one of sectionId or boardId",
      }),
    req.query,
    "query",
  );

  const fields = {
    id: true,
    title: true,
    description: true,
    position: true,
    sectionId: true,
  } as const;

  if (sectionId !== undefined) {
    await requireMember(userId, await orgOfSection(sectionId));
    res.json(
      await prisma.issue.findMany({
        where: { sectionId },
        orderBy: { position: "asc" },
        select: fields,
      }),
    );
    return;
  }

  if (boardId !== undefined) {
    await requireMember(userId, await orgOfBoard(boardId));
    res.json(
      await prisma.issue.findMany({
        where: { section: { boardId } },
        orderBy: [{ section: { position: "asc" } }, { position: "asc" }],
        select: fields,
      }),
    );
    return;
  }

  throw new HttpError(400, "Provide exactly one of sectionId or boardId");
});

app.post("/issue", requireAuth, async (req, res) => {
  const body = parse(
    z.object({ sectionId: z.uuid(), title, description: z.string().max(10_000).optional() }),
    req.body,
    "body",
  );
  await requireMember(auth(req), await orgOfSection(body.sectionId));

  const issue = await prisma.issue.create({
    data: {
      sectionId: body.sectionId,
      title: body.title,
      description: body.description,
      position: await nextIssuePosition(body.sectionId),
    },
    select: { id: true, title: true, description: true, sectionId: true, position: true },
  });
  res.status(201).json(issue);
});

// Registered before /issue/:issueId — Express matches in registration order, so
// the literal path has to win before ":issueId" swallows the word "move".
app.put("/issue/move", requireAuth, async (req, res) => {
  const userId = auth(req);
  const body = parse(
    z.object({ issueId: z.uuid(), sectionId: z.uuid(), position: z.number().optional() }),
    req.body,
    "body",
  );

  const [fromOrg, toOrg] = await Promise.all([
    orgOfIssue(body.issueId),
    orgOfSection(body.sectionId),
  ]);
  await requireMember(userId, fromOrg);
  // Dragging a card into a different organization is never legitimate.
  if (fromOrg !== toOrg) throw new HttpError(403, "Cannot move an issue into another organization");

  // The client sends the midpoint of the two cards it dropped between; with no
  // position we append to the end of the target column.
  const position = body.position ?? (await nextIssuePosition(body.sectionId));

  const issue = await prisma.issue.update({
    where: { id: body.issueId },
    data: { sectionId: body.sectionId, position },
    select: { id: true, title: true, description: true, sectionId: true, position: true },
  });
  res.json(issue);
});

app.get("/issue/:issueId", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfIssue(issueId));

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: {
      id: true,
      title: true,
      description: true,
      position: true,
      section: { select: { id: true, title: true, boardId: true } },
      assignees: { select: { user: { select: { id: true, email: true } } } },
      comments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          content: true,
          createdAt: true,
          user: { select: { id: true, email: true } },
        },
      },
    },
  });
  if (!issue) throw new HttpError(404, "Not found");

  res.json({ ...issue, assignees: issue.assignees.map((a) => a.user) });
});

app.put("/issue/:issueId", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  const body = parse(
    z
      .object({
        title: title.optional(),
        description: z.string().max(10_000).nullable().optional(),
      })
      .refine((v) => v.title !== undefined || v.description !== undefined, {
        message: "Provide at least one of title or description",
      }),
    req.body,
    "body",
  );
  await requireMember(auth(req), await orgOfIssue(issueId));

  const issue = await prisma.issue.update({
    where: { id: issueId },
    data: { title: body.title, description: body.description },
    select: { id: true, title: true, description: true, sectionId: true, position: true },
  });
  res.json(issue);
});

app.delete("/issue/:issueId", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfIssue(issueId));

  await prisma.issue.delete({ where: { id: issueId } });
  res.status(204).end();
});

// --- Comments ---------------------------------------------------------------

app.post("/comment", requireAuth, async (req, res) => {
  const userId = auth(req);
  const body = parse(
    z.object({ issueId: z.uuid(), content: z.string().min(1).max(10_000) }),
    req.body,
    "body",
  );
  await requireMember(userId, await orgOfIssue(body.issueId));

  const comment = await prisma.comment.create({
    data: { issueId: body.issueId, userId, content: body.content },
    select: {
      id: true,
      content: true,
      createdAt: true,
      issueId: true,
      user: { select: { id: true, email: true } },
    },
  });
  res.status(201).json(comment);
});

app.put("/comment/:commentId", requireAuth, async (req, res) => {
  const userId = auth(req);
  const { commentId } = parse(commentIdParam, req.params, "URL parameters");
  const body = parse(z.object({ content: z.string().min(1).max(10_000) }), req.body, "body");

  const existing = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { userId: true, issueId: true },
  });
  if (!existing) throw new HttpError(404, "Not found");
  await requireMember(userId, await orgOfIssue(existing.issueId));
  // Editing someone else's words is never allowed, admin or not.
  if (existing.userId !== userId) throw new HttpError(403, "You can only edit your own comments");

  const comment = await prisma.comment.update({
    where: { id: commentId },
    data: { content: body.content },
    select: {
      id: true,
      content: true,
      createdAt: true,
      issueId: true,
      user: { select: { id: true, email: true } },
    },
  });
  res.json(comment);
});

app.delete("/comment/:commentId", requireAuth, async (req, res) => {
  const userId = auth(req);
  const { commentId } = parse(commentIdParam, req.params, "URL parameters");

  const existing = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { userId: true, issueId: true },
  });
  if (!existing) throw new HttpError(404, "Not found");

  const caller = await requireMember(userId, await orgOfIssue(existing.issueId));
  // Authors delete their own; admins moderate anyone's.
  if (existing.userId !== userId && caller.role !== "ADMIN") {
    throw new HttpError(403, "You can only delete your own comments");
  }

  await prisma.comment.delete({ where: { id: commentId } });
  res.status(204).end();
});

// --- GitHub webhooks --------------------------------------------------------
// GitHub POSTs here for every event the App subscribes to. The order is the
// whole design: verify the signature over the raw bytes, drop redeliveries,
// answer inside the 10-second window GitHub allows, and only then do the work.

const recentDeliveries = new RecentDeliveries();

app.post("/webhooks/github", async (req, res) => {
  const delivery = req.header("x-github-delivery") ?? "";
  const event = req.header("x-github-event") ?? "";
  const action = typeof req.body?.action === "string" ? req.body.action : "";
  console.log(`[github] received ${event}${action ? "." + action : ""} delivery=${delivery || "(none)"}`);

  if (!GITHUB_WEBHOOK_SECRET) throw new HttpError(503, "GitHub webhook secret is not configured");

  const signature = req.header("x-hub-signature-256");
  if (!req.rawBody || !verifyGitHubSignature(GITHUB_WEBHOOK_SECRET, req.rawBody, signature)) {
    console.warn(
      `[github] REJECTED delivery=${delivery || "(none)"}: signature does not match GITHUB_WEBHOOK_SECRET — ` +
        "the secret on the GitHub App page and the one in apps/backend/.env differ",
    );
    throw new HttpError(401, "Invalid webhook signature");
  }

  if (delivery && !recentDeliveries.add(delivery)) {
    console.log(`[github] duplicate delivery=${delivery} ignored`);
    res.status(202).json({ ok: true, duplicate: true });
    return;
  }
  res.status(202).json({ ok: true });

  // The response is gone; from here a failure can only be logged.
  try {
    await handleGitHubEvent(event, req.body);
  } catch (err) {
    console.error(`[github] ${event} ${delivery} failed:`, err);
  }
});

async function handleGitHubEvent(event: string, payload: unknown): Promise<void> {
  if (event === "ping") {
    console.log("[github] ping received \u2014 webhook URL and secret are working");
    return;
  }
  if (event !== "pull_request") return;

  const parsed = pullRequestEvent.safeParse(payload);
  if (!parsed.success) {
    console.warn("[github] pull_request payload missing expected fields:", parsed.error.issues);
    return;
  }
  const move = planMoveForPullRequest(parsed.data);
  if (!move) {
    console.log(`[github] pull_request ${parsed.data.action} #${parsed.data.pull_request.number}: nothing to move`);
    return;
  }
  await moveCardOnBoard(move);
}

/** Asks the socket server \u2014 which owns the in-memory board today \u2014 to move a card. */
async function moveCardOnBoard(move: CardMove): Promise<void> {
  if (!WS_INTERNAL_TOKEN) throw new Error("WS_INTERNAL_TOKEN not set; cannot reach the socket server");
  const response = await fetch(`${WS_INTERNAL_URL}/internal/issue-moved`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${WS_INTERNAL_TOKEN}` },
    body: JSON.stringify(move),
  });
  if (!response.ok) throw new Error(`socket server answered ${response.status}: ${await response.text()}`);
  console.log(`[github] ${move.key} → ${move.sectionId} (${move.reason})`);
}

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

app.use((_req, _res, next: NextFunction) => {
  next(new HttpError(404, "No such route"));
});

function isPrismaError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === code
  );
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    });
    return;
  }
  // P2002 unique violation, P2025 record not found — the database enforcing a
  // constraint the request violated, not a server fault.
  if (isPrismaError(err, "P2002")) {
    res.status(409).json({ error: "That record already exists" });
    return;
  }
  if (isPrismaError(err, "P2025")) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  console.error("[unhandled]", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`backend listening on http://localhost:${PORT}`);
});
