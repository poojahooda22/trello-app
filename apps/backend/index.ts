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
  issuesEvent,
  planForIssue,
  planMoveForPullRequest,
  pullRequestEvent,
  verifyGitHubSignature,
  type CardMove,
  type IssuePlan,
} from "./github-webhook";
import {
  DEFAULT_SECTIONS,
  LABEL_COLORS,
  PRIORITIES,
  canMove,
  issueKey,
  keyPrefixFor,
  parseIssueKey,
  type IssueDto,
  type LabelDto,
  type UserRef,
} from "./board-rules";
import { mintRoomToken, publish } from "./realtime";
import {
  REPO_PATTERN,
  SLACK_WEBHOOK_PATTERN,
  boardForRepo,
  boardLink,
  canonicalRepo,
  connectGitHub,
  connectSlack,
  disconnect,
  escapeSlack,
  listIntegrations,
  notifyBoard,
  recordGitHub,
  repoForBoard,
  sendSlack,
  setEnabled,
  setMirrorIssues,
} from "./integrations";
import {
  createGitHubIssue,
  findInstallationForRepo,
  githubAppConfigured,
  listOpenPullRequests,
  setGitHubIssueState,
} from "./github-app";
import { encryptionAvailable } from "./secrets";

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

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
if (!GITHUB_WEBHOOK_SECRET) {
  console.warn("GITHUB_WEBHOOK_SECRET not set — POST /webhooks/github answers 503 until it is.");
}

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
    rawBody?: Buffer;
  }
}

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

const issueSelect = {
  id: true,
  number: true,
  title: true,
  description: true,
  position: true,
  sectionId: true,
  boardId: true,
  version: true,
  githubNumber: true,
  priority: true,
  board: { select: { keyPrefix: true } },
  assignees: { select: { user: { select: { id: true, email: true } } } },
  labels: { select: { label: { select: { id: true, name: true, color: true } } } },
} as const;

type IssueRow = Omit<IssueDto, "key" | "assignees" | "labels"> & {
  board: { keyPrefix: string };
  assignees: { user: UserRef }[];
  labels: { label: LabelDto }[];
};

/** Flattens the join rows so clients get plain arrays, not `{ user: … }` wrappers. */
function toIssueDto({ board, assignees, labels, ...issue }: IssueRow): IssueDto {
  return {
    ...issue,
    key: issueKey(board.keyPrefix, issue.number),
    assignees: assignees.map((a) => a.user),
    labels: labels.map((l) => l.label),
  };
}

/** Boards created before columns had kinds get the five defaults on first read. */
async function ensureDefaultSections(boardId: string): Promise<void> {
  const kinded = await prisma.section.count({ where: { boardId, kind: { not: null } } });
  if (kinded > 0) return;
  // Appended after any existing custom columns so positions never collide.
  const start = await nextSectionPosition(boardId);
  await prisma.section.createMany({
    data: DEFAULT_SECTIONS.map((s, i) => ({ boardId, title: s.title, kind: s.kind, position: start + i * POSITION_GAP })),
    skipDuplicates: true,
  });
}

/** ZEP, then ZEP2, ZEP3… so two boards in one organization never share card keys. */
async function uniqueKeyPrefix(orgId: string, title: string): Promise<string> {
  const base = keyPrefixFor(title);
  const boards = await prisma.board.findMany({ where: { organizationId: orgId }, select: { keyPrefix: true } });
  const taken = new Set(boards.map((b) => b.keyPrefix));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}${n}`)) return `${base}${n}`;
  }
}

/**
 * The one place a card is created, whether a person added it or a GitHub issue
 * arrived. One UPDATE hands out the next number, and its row lock serializes
 * creates per board so the position read cannot tie.
 */
async function createCard(input: {
  boardId: string;
  sectionId: string;
  title: string;
  description: string | null;
  githubNumber?: number;
}): Promise<IssueDto> {
  return toIssueDto(
    await prisma.$transaction(async (tx) => {
      const { issueCounter } = await tx.board.update({
        where: { id: input.boardId },
        data: { issueCounter: { increment: 1 } },
        select: { issueCounter: true },
      });
      const last = await tx.issue.findFirst({
        where: { sectionId: input.sectionId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      return tx.issue.create({
        data: {
          sectionId: input.sectionId,
          boardId: input.boardId,
          number: issueCounter,
          title: input.title,
          description: input.description,
          githubNumber: input.githubNumber ?? null,
          position: (last?.position ?? 0) + POSITION_GAP,
        },
        select: issueSelect,
      });
    }),
  );
}

/**
 * The one place an issue changes column. Users go through the transition table;
 * automation (GitHub) may jump straight to Review or Done.
 */
async function moveIssueTo(
  issueId: string,
  sectionId: string,
  opts: {
    position?: number;
    enforceRules: boolean;
    reason?: string;
    /**
     * The GitHub issue number whose event caused this move. Only that issue's
     * own state is left alone; a move caused by a *pull request* still closes
     * the linked issue, which is the whole point of merging.
     */
    echoOfIssue?: number;
  },
): Promise<IssueDto> {
  const [issue, target] = await Promise.all([
    prisma.issue.findUnique({
      where: { id: issueId },
      select: { ...issueSelect, section: { select: { kind: true, title: true } } },
    }),
    prisma.section.findUnique({ where: { id: sectionId }, select: { boardId: true, kind: true, title: true } }),
  ]);
  if (!issue || !target) throw new HttpError(404, "Not found");
  if (issue.boardId !== target.boardId) throw new HttpError(400, "Cannot move an issue to another board");
  if (opts.enforceRules && !canMove(issue.section.kind, target.kind)) {
    throw new HttpError(409, `Cannot move a card from ${issue.section.title} to ${target.title}`);
  }

  const position = opts.position ?? (await nextIssuePosition(sectionId));
  // Guarded write: it only lands if the card is still where the check saw it,
  // so two racing moves cannot combine into a transition the table forbids.
  const { count } = await prisma.issue.updateMany({
    where: { id: issueId, sectionId: issue.sectionId },
    data: { sectionId, position, version: { increment: 1 } },
  });
  if (count === 0) throw new HttpError(409, "The card was moved by someone else — reload and try again");

  const updated = toIssueDto(await prisma.issue.findUniqueOrThrow({ where: { id: issueId }, select: issueSelect }));
  publish(updated.boardId, { type: "issue_moved", issue: updated });
  if (issue.sectionId !== sectionId) {
    const why = opts.reason ? ` — ${escapeSlack(opts.reason)}` : "";
    // The title links to the board, so the message is one click from the work.
    notifyBoard(
      updated.boardId,
      `${updated.key} · ${boardLink(updated.boardId, updated.title)} moved ${escapeSlack(issue.section.title)} → ${escapeSlack(target.title)}${why}`,
    );
    // Dragging a mirrored card into Done closes its GitHub issue (and out of
    // Done, back into a workflow column, reopens it). Two guards: the event
    // that came from this very issue is not echoed back, and a move into a
    // custom column says nothing about whether the work is done.
    const crossesDone = target.kind === "DONE" || (issue.section.kind === "DONE" && target.kind !== null);
    if (updated.githubNumber !== null && updated.githubNumber !== opts.echoOfIssue && crossesDone) {
      void syncGitHubIssueState(updated, target.kind === "DONE" ? "closed" : "open");
    }
  }
  return updated;
}

/** Mirrors a card's Done/not-Done state onto its GitHub issue. */
async function syncGitHubIssueState(issue: IssueDto, state: "open" | "closed"): Promise<void> {
  if (issue.githubNumber === null) return;
  try {
    const link = await repoForBoard(issue.boardId);
    if (!link?.enabled || !link.mirrorIssues || link.installationId === null) return;
    await setGitHubIssueState(link.installationId, link.fullName, issue.githubNumber, state);
    await recordGitHub(issue.boardId, null);
    console.log(`[github] ${issue.key} → issue #${issue.githubNumber} ${state}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordGitHub(issue.boardId, `Updating GitHub issue #${issue.githubNumber} failed: ${message}`).catch(() => {});
    console.error(`[github] ${issue.key}: ${message}`);
  }
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

  // (organizationId, keyPrefix) is unique in the database; when two same-title
  // boards are created at once the loser re-reads and takes the next suffix.
  let board;
  for (let attempt = 0; ; attempt++) {
    try {
      board = await prisma.board.create({
        data: {
          title: body.title,
          organizationId: body.orgId,
          keyPrefix: await uniqueKeyPrefix(body.orgId, body.title),
          sections: {
            create: DEFAULT_SECTIONS.map((s, i) => ({ title: s.title, kind: s.kind, position: (i + 1) * POSITION_GAP })),
          },
        },
        select: { id: true, title: true, organizationId: true, keyPrefix: true },
      });
      break;
    } catch (err) {
      if (!isPrismaError(err, "P2002") || attempt >= 3) throw err;
    }
  }
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
  const userId = auth(req);
  const { boardId } = parse(boardIdParam, req.query, "query");
  await requireMember(userId, await orgOfBoard(boardId));

  await ensureDefaultSections(boardId);
  // Issues are nested so the whole board renders from one round trip. The
  // roomToken is the tab's proof of membership for the socket relay.
  const sections = await prisma.section.findMany({
    where: { boardId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      id: true,
      title: true,
      kind: true,
      position: true,
      issues: { orderBy: [{ position: "asc" }, { number: "asc" }], select: issueSelect },
    },
  });
  // The token carries the caller's identity so board presence shows real
  // users (the "random id" placeholder in the old socket server is gone).
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  res.json({
    roomToken: me ? mintRoomToken(boardId, { id: userId, email: me.email }) : "",
    sections: sections.map((s) => ({ ...s, issues: s.issues.map(toIssueDto) })),
  });
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
    select: { id: true, title: true, kind: true, boardId: true, position: true },
  });
  publish(section.boardId, { type: "section_added", section });
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
    select: { id: true, title: true, kind: true, boardId: true, position: true },
  });
  publish(section.boardId, { type: "section_updated", section });
  res.json(section);
});

app.delete("/section/:sectionId", requireAuth, async (req, res) => {
  const { sectionId } = parse(sectionIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfSection(sectionId));

  const section = await prisma.section.findUnique({ where: { id: sectionId }, select: { kind: true, boardId: true } });
  if (!section) throw new HttpError(404, "Not found");
  // The five workflow columns are the contract the automation depends on.
  if (section.kind !== null) throw new HttpError(409, "Default columns cannot be deleted");

  // Cascades to the issues in the column.
  await prisma.section.delete({ where: { id: sectionId } });
  publish(section.boardId, { type: "section_deleted", sectionId });
  res.status(204).end();
});


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

  if (sectionId !== undefined) {
    await requireMember(userId, await orgOfSection(sectionId));
    const rows = await prisma.issue.findMany({
      where: { sectionId },
      orderBy: [{ position: "asc" }, { number: "asc" }],
      select: issueSelect,
    });
    res.json(rows.map(toIssueDto));
    return;
  }

  if (boardId !== undefined) {
    await requireMember(userId, await orgOfBoard(boardId));
    const rows = await prisma.issue.findMany({
      where: { boardId },
      orderBy: [{ section: { position: "asc" } }, { position: "asc" }, { number: "asc" }],
      select: issueSelect,
    });
    res.json(rows.map(toIssueDto));
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
  const section = await prisma.section.findUnique({
    where: { id: body.sectionId },
    select: { boardId: true, title: true, board: { select: { organizationId: true } } },
  });
  if (!section) throw new HttpError(404, "Not found");
  await requireMember(auth(req), section.board.organizationId);

  const issue = await createCard({
    boardId: section.boardId,
    sectionId: body.sectionId,
    title: body.title,
    description: body.description ?? null,
  });
  publish(issue.boardId, { type: "issue_added", issue });
  notifyBoard(
    issue.boardId,
    `${issue.key} · New card in *${escapeSlack(section.title)}*: ${boardLink(issue.boardId, issue.title)}`,
  );
  // If the board mirrors to GitHub, the issue is created there too. Off the
  // response path: the card already exists, and GitHub must not delay it.
  void mirrorCardToGitHub(issue);
  res.status(201).json(issue);
});

/**
 * Creates the GitHub issue for a new card when the board is bound to a
 * repository with mirroring on. The resulting `issues.opened` webhook finds the
 * card already carrying this number and updates it instead of duplicating it.
 */
async function mirrorCardToGitHub(issue: IssueDto): Promise<void> {
  try {
    const link = await repoForBoard(issue.boardId);
    if (!link?.enabled || !link.mirrorIssues || link.installationId === null) return;

    const created = await createGitHubIssue(link.installationId, link.fullName, {
      title: issue.title,
      body: `${issue.description ?? ""}\n\n---\nTracked as **${issue.key}** on ${APP_URL}/boards/${issue.boardId}`.trim(),
    });
    // GitHub may deliver issues.opened before this write lands. Claiming the
    // number only while the card is still unlinked makes the two orders agree.
    const { count } = await prisma.issue.updateMany({
      where: { id: issue.id, githubNumber: null },
      data: { githubNumber: created.number, version: { increment: 1 } },
    });
    if (count === 0) {
      console.log(`[github] ${issue.key} was already linked while creating issue #${created.number} — left as is`);
      return;
    }
    await publishIssue(issue.id); // publishes the linked card to open boards
    await recordGitHub(issue.boardId, null);
    console.log(`[github] ${issue.key} → created issue #${created.number} in ${link.fullName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordGitHub(issue.boardId, `Creating the GitHub issue failed: ${message}`).catch(() => {});
    console.error(`[github] mirroring ${issue.key} failed:`, message);
  }
}

app.put("/issue/move", requireAuth, async (req, res) => {
  const userId = auth(req);
  const body = parse(
    z.object({ issueId: z.uuid(), sectionId: z.uuid(), position: z.number().optional() }),
    req.body,
    "body",
  );

  await requireMember(userId, await orgOfIssue(body.issueId));
  res.json(await moveIssueTo(body.issueId, body.sectionId, { position: body.position, enforceRules: true }));
});

/** Everything the issue detail page shows in one request. */
app.get("/issue/:issueId", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfIssue(issueId));

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: {
      ...issueSelect,
      section: { select: { id: true, title: true, kind: true } },
      board: { select: { keyPrefix: true, organizationId: true, title: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, content: true, createdAt: true, user: { select: { id: true, email: true } } },
      },
    },
  });
  if (!issue) throw new HttpError(404, "Not found");

  const { comments, section, ...row } = issue;
  const link = await repoForBoard(row.boardId);
  res.json({
    ...toIssueDto(row),
    section,
    comments,
    // The page needs the workspace to offer its members as assignees.
    organizationId: row.board.organizationId,
    boardTitle: row.board.title,
    // Where this card lives outside the board, so the page can link out.
    repository: link?.fullName ?? null,
    githubUrl: link && row.githubNumber !== null ? `https://github.com/${link.fullName}/issues/${row.githubNumber}` : null,
  });
});

// --- Assignees, labels and priority ------------------------------------------

/** Publishes the card so every open board reflects the change immediately. */
async function publishIssue(issueId: string): Promise<IssueDto> {
  const issue = toIssueDto(await prisma.issue.findUniqueOrThrow({ where: { id: issueId }, select: issueSelect }));
  publish(issue.boardId, { type: "issue_updated", issue });
  return issue;
}

app.post("/issue/:issueId/assignee", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  const body = parse(z.object({ userId: z.uuid() }), req.body, "body");
  const orgId = await orgOfIssue(issueId);
  await requireMember(auth(req), orgId);
  // Only someone already in the organization can be assigned its work.
  await requireMember(body.userId, orgId).catch(() => {
    throw new HttpError(400, "That user is not a member of this workspace");
  });

  await prisma.issueMapping.upsert({
    where: { userId_issueId: { userId: body.userId, issueId } },
    create: { userId: body.userId, issueId },
    update: {},
  });
  res.json(await publishIssue(issueId));
});

app.delete("/issue/:issueId/assignee/:userId", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  const { userId } = parse(z.object({ userId: z.uuid() }), req.params, "URL parameters");
  await requireMember(auth(req), await orgOfIssue(issueId));

  await prisma.issueMapping.deleteMany({ where: { issueId, userId } });
  res.json(await publishIssue(issueId));
});

app.get("/board/:boardId/labels", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfBoard(boardId));
  res.json(await prisma.label.findMany({ where: { boardId }, orderBy: { name: "asc" } }));
});

app.post("/board/:boardId/label", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  const body = parse(
    z.object({ name: z.string().min(1).max(40), color: z.enum(LABEL_COLORS).optional() }),
    req.body,
    "body",
  );
  await requireMember(auth(req), await orgOfBoard(boardId));

  const label = await prisma.label.upsert({
    where: { boardId_name: { boardId, name: body.name } },
    create: { boardId, name: body.name, color: body.color ?? "grey" },
    update: { color: body.color ?? undefined },
  });
  res.status(201).json(label);
});

app.delete("/label/:labelId", requireAuth, async (req, res) => {
  const { labelId } = parse(z.object({ labelId: z.uuid() }), req.params, "URL parameters");
  const label = await prisma.label.findUnique({ where: { id: labelId }, select: { boardId: true } });
  if (!label) throw new HttpError(404, "Not found");
  await requireMember(auth(req), await orgOfBoard(label.boardId));

  await prisma.label.delete({ where: { id: labelId } });
  res.status(204).end();
});

app.post("/issue/:issueId/label", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  const body = parse(z.object({ labelId: z.uuid() }), req.body, "body");
  await requireMember(auth(req), await orgOfIssue(issueId));

  const [issue, label] = await Promise.all([
    prisma.issue.findUnique({ where: { id: issueId }, select: { boardId: true } }),
    prisma.label.findUnique({ where: { id: body.labelId }, select: { boardId: true } }),
  ]);
  if (!issue || !label) throw new HttpError(404, "Not found");
  // A label belongs to one board; it must not travel to another's cards.
  if (issue.boardId !== label.boardId) throw new HttpError(400, "That label belongs to another board");

  await prisma.issueLabel.upsert({
    where: { issueId_labelId: { issueId, labelId: body.labelId } },
    create: { issueId, labelId: body.labelId },
    update: {},
  });
  res.json(await publishIssue(issueId));
});

app.delete("/issue/:issueId/label/:labelId", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  const { labelId } = parse(z.object({ labelId: z.uuid() }), req.params, "URL parameters");
  await requireMember(auth(req), await orgOfIssue(issueId));

  await prisma.issueLabel.deleteMany({ where: { issueId, labelId } });
  res.json(await publishIssue(issueId));
});

app.put("/issue/:issueId", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  const body = parse(
    z
      .object({
        title: title.optional(),
        description: z.string().max(10_000).nullable().optional(),
        priority: z.enum(PRIORITIES).nullable().optional(),
      })
      .refine((v) => v.title !== undefined || v.description !== undefined || v.priority !== undefined, {
        message: "Provide at least one of title, description or priority",
      }),
    req.body,
    "body",
  );
  await requireMember(auth(req), await orgOfIssue(issueId));

  const issue = toIssueDto(
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        title: body.title,
        description: body.description,
        priority: body.priority,
        version: { increment: 1 },
      },
      select: issueSelect,
    }),
  );
  publish(issue.boardId, { type: "issue_updated", issue });
  res.json(issue);
});

app.delete("/issue/:issueId", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfIssue(issueId));

  const existing = await prisma.issue.findUnique({ where: { id: issueId }, select: { boardId: true } });
  if (!existing) throw new HttpError(404, "Not found");
  await prisma.issue.delete({ where: { id: issueId } });
  publish(existing.boardId, { type: "issue_deleted", issueId });
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

// --- Integrations -----------------------------------------------------------
// A board's own Slack connection. The webhook URL is a credential: it is
// encrypted at rest and never sent back — the UI gets a masked hint instead.

const slackConnect = z.object({
  webhookUrl: z.string().regex(SLACK_WEBHOOK_PATTERN, "Must be a https://hooks.slack.com/services/… URL"),
  label: z.string().max(80).optional(),
});

/** Integrations are org-wide plumbing, so only admins may change them. */
async function requireBoardAdmin(req: Request, boardId: string) {
  await requireMember(auth(req), await orgOfBoard(boardId), { admin: true });
  if (!encryptionAvailable) throw new HttpError(503, "INTEGRATION_KEY is not configured on the server");
}

app.get("/board/:boardId/integrations", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfBoard(boardId));
  res.json(await listIntegrations(boardId));
});

app.put("/board/:boardId/integration/slack", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  const body = parse(slackConnect, req.body, "body");
  await requireBoardAdmin(req, boardId);

  await connectSlack(boardId, body.webhookUrl, body.label?.trim() || null);
  res.json(await listIntegrations(boardId));
});

app.post("/board/:boardId/integration/slack/test", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  await requireBoardAdmin(req, boardId);

  const board = await prisma.board.findUnique({ where: { id: boardId }, select: { title: true } });
  const result = await sendSlack(boardId, `✅ *${escapeSlack(board?.title ?? "This board")}* is connected to this channel.`);
  // "Nothing was sent" must never be reported as a delivery.
  const error =
    result.status === "failed"
      ? result.error
      : result.status === "skipped"
        ? result.reason === "paused"
          ? "Slack is paused for this board — resume it first"
          : "Slack is not connected to this board"
        : null;
  res.json({ ok: result.status === "sent", error, integrations: await listIntegrations(boardId) });
});

const githubConnect = z.object({
  repository: z.string().regex(REPO_PATTERN, 'Must be "owner/repo"'),
  mirrorIssues: z.boolean().optional(),
});

app.put("/board/:boardId/integration/github", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  const body = parse(githubConnect, req.body, "body");
  await requireBoardAdmin(req, boardId);

  // Bound elsewhere already? Refuse rather than silently stealing the link:
  // one repository feeding two boards would double every card. Compared in
  // GitHub's own case-insensitive terms, so "Acme/API" cannot slip past.
  const repository = canonicalRepo(body.repository);
  const existing = await boardForRepo(repository);
  if (existing && existing.boardId !== boardId) {
    throw new HttpError(409, "That repository is already linked to another board");
  }

  // Knowing the installation is what makes writes possible; without the App
  // credentials the link still works for incoming webhooks.
  let installationId: number | null = null;
  let warning: string | null = null;
  if (githubAppConfigured) {
    try {
      installationId = await findInstallationForRepo(repository);
      if (installationId === null) warning = "The GitHub App is not installed on that repository yet.";
    } catch (err) {
      // Leaves installationId null, which connectGitHub reads as "unknown" and
      // does not write over a good value it already had.
      warning = `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    warning = "GITHUB_APP_ID / GITHUB_PRIVATE_KEY are not set, so cards cannot be pushed to GitHub.";
  }

  await connectGitHub(boardId, repository, installationId, body.mirrorIssues ?? false);
  res.json({ integrations: await listIntegrations(boardId), warning });
});

app.get("/board/:boardId/github/pulls", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfBoard(boardId));

  const link = await repoForBoard(boardId);
  if (!link || link.installationId === null) {
    res.json({ repository: link?.fullName ?? null, pulls: [] });
    return;
  }
  try {
    res.json({ repository: link.fullName, pulls: await listOpenPullRequests(link.installationId, link.fullName) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordGitHub(boardId, `Listing pull requests failed: ${message}`);
    throw new HttpError(502, `GitHub: ${message}`);
  }
});

/** Pushes an existing card to GitHub as an issue, so the repo side can see it. */
app.post("/issue/:issueId/github", requireAuth, async (req, res) => {
  const { issueId } = parse(issueIdParam, req.params, "URL parameters");
  await requireMember(auth(req), await orgOfIssue(issueId));

  const card = toIssueDto(await prisma.issue.findUniqueOrThrow({ where: { id: issueId }, select: issueSelect }));
  if (card.githubNumber !== null) throw new HttpError(409, "That card is already linked to a GitHub issue");

  const link = await repoForBoard(card.boardId);
  if (!link) throw new HttpError(409, "This board has no linked repository");
  if (link.installationId === null) throw new HttpError(409, "The GitHub App is not installed on that repository");

  try {
    const created = await createGitHubIssue(link.installationId, link.fullName, {
      title: card.title,
      body: `${card.description ?? ""}\n\n---\nTracked as **${card.key}** on ${APP_URL}/boards/${card.boardId}`.trim(),
    });
    const updated = toIssueDto(
      await prisma.issue.update({
        where: { id: issueId },
        data: { githubNumber: created.number, version: { increment: 1 } },
        select: issueSelect,
      }),
    );
    publish(updated.boardId, { type: "issue_updated", issue: updated });
    await recordGitHub(card.boardId, null);
    res.status(201).json({ issue: updated, url: created.htmlUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordGitHub(card.boardId, `Creating the GitHub issue failed: ${message}`);
    throw new HttpError(502, `GitHub: ${message}`);
  }
});

/** The mirror flag alone — toggling it must not re-run repository binding. */
app.patch("/board/:boardId/integration/github/mirror", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  const body = parse(z.object({ mirrorIssues: z.boolean() }), req.body, "body");
  await requireBoardAdmin(req, boardId);

  const link = await repoForBoard(boardId);
  if (!link) throw new HttpError(409, "This board has no linked repository");
  await setMirrorIssues(boardId, body.mirrorIssues);
  res.json(await listIntegrations(boardId));
});

app.patch("/board/:boardId/integration/:provider", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  const { provider } = parse(z.object({ provider: z.enum(["SLACK", "GITHUB"]) }), req.params, "URL parameters");
  const body = parse(z.object({ enabled: z.boolean() }), req.body, "body");
  await requireBoardAdmin(req, boardId);

  await setEnabled(boardId, provider, body.enabled);
  res.json(await listIntegrations(boardId));
});

app.delete("/board/:boardId/integration/:provider", requireAuth, async (req, res) => {
  const { boardId } = parse(boardIdParam, req.params, "URL parameters");
  const { provider } = parse(z.object({ provider: z.enum(["SLACK", "GITHUB"]) }), req.params, "URL parameters");
  await requireBoardAdmin(req, boardId);

  await disconnect(boardId, provider);
  res.json(await listIntegrations(boardId));
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

  if (!GITHUB_WEBHOOK_SECRET) throw new HttpError(503, "GitHub webhook secret is not configured");

  const signature = req.header("x-hub-signature-256");
  if (!req.rawBody || !verifyGitHubSignature(GITHUB_WEBHOOK_SECRET, req.rawBody, signature)) {
    console.warn(
      `[github] REJECTED delivery=${delivery || "(none)"}: signature does not match GITHUB_WEBHOOK_SECRET — ` +
        "the secret on the GitHub App page and the one in apps/backend/.env differ",
    );
    throw new HttpError(401, "Invalid webhook signature");
  }
  // Only signed (therefore GitHub-authored) requests reach the log.
  console.log(`[github] received ${event}${action ? "." + action : ""} delivery=${delivery || "(none)"}`);

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

/**
 * Every event is scoped to the board its repository is bound to. A repository
 * nobody linked is ignored — without that, a card key like ZEP-7 would be
 * matched across every organization on the server.
 */
async function handleGitHubEvent(event: string, payload: unknown): Promise<void> {
  if (event === "ping") {
    console.log("[github] ping received — webhook URL and secret are working");
    return;
  }
  if (event !== "pull_request" && event !== "issues") return;

  const repoName = (payload as { repository?: { full_name?: unknown } })?.repository?.full_name;
  if (typeof repoName !== "string") return;
  const link = await boardForRepo(repoName);
  if (!link) {
    console.log(`[github] ${repoName} is not linked to a board — ignored`);
    return;
  }
  if (!link.enabled) {
    console.log(`[github] ${repoName} is linked but paused — ignored`);
    return;
  }

  if (event === "pull_request") {
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
    await serializedByKey(`${link.boardId}:${move.key}`, () => moveCardOnBoard(link.boardId, move));
    return;
  }

  const parsed = issuesEvent.safeParse(payload);
  if (!parsed.success) {
    console.warn("[github] issues payload missing expected fields:", parsed.error.issues);
    return;
  }
  const plan = planForIssue(parsed.data);
  if (!plan) {
    console.log(`[github] issues.${parsed.data.action} #${parsed.data.issue.number}: nothing to mirror`);
    return;
  }
  await serializedByKey(`${link.boardId}:gh#${plan.number}`, () => applyIssuePlan(link.boardId, plan));
}

// Events for the same card run one after another, so "opened" then "merged"
// arriving together cannot finish in the wrong order.
const inFlightByKey = new Map<string, Promise<void>>();
function serializedByKey(key: string, task: () => Promise<void>): Promise<void> {
  const run = (inFlightByKey.get(key) ?? Promise.resolve()).then(task, task);
  inFlightByKey.set(key, run);
  return run.finally(() => {
    if (inFlightByKey.get(key) === run) inFlightByKey.delete(key);
  });
}

/** Finds the card by key WITHIN the bound board and moves it to that column kind. */
async function moveCardOnBoard(boardId: string, move: CardMove): Promise<void> {
  const parsed = parseIssueKey(move.key);
  if (!parsed) return;
  const board = await prisma.board.findUnique({ where: { id: boardId }, select: { keyPrefix: true } });
  if (board?.keyPrefix !== parsed.prefix) {
    console.log(`[github] ${move.key}: not a key of the linked board (${board?.keyPrefix}) — ignored`);
    return;
  }
  const match = await prisma.issue.findUnique({
    where: { boardId_number: { boardId, number: parsed.number } },
    select: { id: true },
  });
  if (!match) {
    console.warn(`[github] ${move.key}: no such card on the linked board`);
    return;
  }
  const target = await prisma.section.findFirst({ where: { boardId, kind: move.kind }, select: { id: true } });
  if (!target) {
    console.warn(`[github] ${move.key}: the board has no ${move.kind} column`);
    return;
  }
  // No echoOfIssue: a merged pull request SHOULD close the card's linked issue.
  await moveIssueTo(match.id, target.id, { enforceRules: false, reason: move.reason });
  await recordGitHub(boardId, null);
  console.log(`[github] ${move.key} → ${move.kind} (${move.reason})`);
}

/** Applies a GitHub issue event to the board's cards. Idempotent, so our own echoes are harmless. */
async function applyIssuePlan(boardId: string, plan: IssuePlan): Promise<void> {
  const existing = await prisma.issue.findUnique({
    where: { boardId_githubNumber: { boardId, githubNumber: plan.number } },
    select: { ...issueSelect, section: { select: { kind: true } } },
  });

  if (plan.type === "create") {
    // Already linked? This is the echo of an issue THIS board created. The
    // board is the source of truth for its own card, and the body we posted
    // carries a tracking footer — writing it back would put that footer into
    // the user's description. So: acknowledge and change nothing.
    if (existing) return;
    const backlog = await prisma.section.findFirst({ where: { boardId, kind: "BACKLOG" }, select: { id: true } });
    if (!backlog) {
      console.warn(`[github] issue #${plan.number}: the board has no Backlog column`);
      return;
    }
    const card = await createCard({
      boardId,
      sectionId: backlog.id,
      title: plan.title,
      description: plan.body,
      githubNumber: plan.number,
    });
    publish(boardId, { type: "issue_added", issue: card });
    notifyBoard(
      boardId,
      `${card.key} · New card from GitHub issue #${plan.number} by ${escapeSlack(plan.author)}: ${boardLink(boardId, card.title)}`,
    );
    await recordGitHub(boardId, null);
    console.log(`[github] issue #${plan.number} → new card ${card.key}`);
    return;
  }

  if (!existing) {
    console.log(`[github] issue #${plan.number}: no card mirrors it — ignored`);
    return;
  }

  if (plan.type === "delete") {
    await prisma.issue.delete({ where: { id: existing.id } });
    publish(boardId, { type: "issue_deleted", issueId: existing.id });
    await recordGitHub(boardId, null);
    return;
  }

  if (plan.type === "edit") {
    // Write only what GitHub reports as changed. Editing an issue's body must
    // not revert a title someone renamed on the board.
    const data: { title?: string; description?: string | null } = {};
    if (plan.changedTitle) data.title = plan.title;
    if (plan.changedBody) data.description = plan.body;
    if (Object.keys(data).length === 0) return;

    const updated = toIssueDto(
      await prisma.issue.update({
        where: { id: existing.id },
        data: { ...data, version: { increment: 1 } },
        select: issueSelect,
      }),
    );
    publish(boardId, { type: "issue_updated", issue: updated });
    await recordGitHub(boardId, null);
    return;
  }

  // plan.type === "state": closed → Done, reopened → back to To Do.
  if (existing.section.kind === plan.kind) return; // already there; nothing to say
  // Reopening returns a card from Done. A card parked anywhere else — in
  // progress, or in a custom column — is where someone deliberately put it.
  if (plan.kind === "TODO" && existing.section.kind !== "DONE") return;
  const target = await prisma.section.findFirst({ where: { boardId, kind: plan.kind }, select: { id: true } });
  if (!target) {
    console.warn(`[github] issue #${plan.number}: the board has no ${plan.kind} column`);
    return;
  }
  await moveIssueTo(existing.id, target.id, { enforceRules: false, reason: plan.reason, echoOfIssue: plan.number });
  await recordGitHub(boardId, null);
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
