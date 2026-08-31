/**
 * Realtime relay. Holds no board data: the backend owns every write and calls
 * POST /internal/broadcast to fan a change out to the tabs viewing that board.
 * A join must present a room token minted by the backend; the token carries the
 * member's real identity (user id + email), so presence shows people, not
 * random ids, and the relay never needs the database.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const WS_PORT = Number(process.env.WS_PORT ?? 3002);
const WS_INTERNAL_PORT = Number(process.env.WS_INTERNAL_PORT ?? 3003);
const WS_INTERNAL_TOKEN = process.env.WS_INTERNAL_TOKEN;
if (!WS_INTERNAL_TOKEN) {
  console.warn("WS_INTERNAL_TOKEN is not set in apps/websockets/.env — joins and broadcasts are off");
}

type RoomUser = { id: string; email: string };

/** Verifies a token minted by the backend's mintRoomToken and returns who it names. */
function verifyRoomToken(boardId: string, token: unknown): RoomUser | null {
  if (!WS_INTERNAL_TOKEN || typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(createHmac("sha256", WS_INTERNAL_TOKEN).update(payload).digest("hex"));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (decoded.boardId !== boardId) return null;
    if (typeof decoded.exp !== "number" || decoded.exp < Date.now()) return null;
    if (typeof decoded.user?.id !== "string" || typeof decoded.user?.email !== "string") return null;
    return { id: decoded.user.id, email: decoded.user.email };
  } catch {
    return null;
  }
}

type Member = { user: RoomUser; socket: WebSocket };
const rooms = new Map<string, Member[]>();

function send(socket: WebSocket, message: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(boardId: string, message: unknown, except?: WebSocket): number {
  let delivered = 0;
  for (const member of rooms.get(boardId) ?? []) {
    if (member.socket === except) continue;
    send(member.socket, message);
    delivered++;
  }
  return delivered;
}

function leave(boardId: string, socket: WebSocket) {
  const members = rooms.get(boardId);
  if (!members) return;
  const me = members.find((m) => m.socket === socket);
  if (!me) return;
  const rest = members.filter((m) => m.socket !== socket);
  if (rest.length) rooms.set(boardId, rest);
  else rooms.delete(boardId);
  // Another tab of the same person still open? Then they have not left.
  if (!rest.some((m) => m.user.id === me.user.id)) {
    broadcast(boardId, { type: "leave", userId: me.user.id });
  }
}

const server = new WebSocketServer({ port: WS_PORT, maxPayload: 4 * 1024 });

server.on("connection", (socket) => {
  let joined: string | null = null;

  socket.on("message", (raw) => {
    let message: { type?: unknown; boardId?: unknown; token?: unknown };
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type !== "join" || typeof message.boardId !== "string") return;
    if (joined === message.boardId) return;
    const user = verifyRoomToken(message.boardId, message.token);
    if (!user) {
      send(socket, { type: "error", error: "unauthorized" });
      socket.close(4001, "unauthorized");
      return;
    }

    if (joined) leave(joined, socket);
    const boardId = message.boardId;
    const others = rooms.get(boardId) ?? [];
    // One avatar per person: a second tab of the same user is not a new join.
    if (!others.some((m) => m.user.id === user.id)) {
      broadcast(boardId, { type: "join", user });
    }
    rooms.set(boardId, [...others, { user, socket }]);
    joined = boardId;
    const visible = [...new Map(others.filter((m) => m.user.id !== user.id).map((m) => [m.user.id, m.user])).values()];
    send(socket, { type: "initial_state", users: visible });
  });

  socket.on("close", () => {
    if (joined) leave(joined, socket);
  });
});

Bun.serve({
  port: WS_INTERNAL_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/internal/broadcast") {
      return new Response("not found", { status: 404 });
    }
    if (!WS_INTERNAL_TOKEN) return new Response("WS_INTERNAL_TOKEN not configured", { status: 503 });
    if (req.headers.get("authorization") !== `Bearer ${WS_INTERNAL_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const body = (await req.json()) as { boardId?: unknown; event?: unknown };
    if (typeof body.boardId !== "string" || typeof body.event !== "object" || body.event === null) {
      return Response.json({ error: "expected { boardId: string, event: object }" }, { status: 400 });
    }
    const delivered = broadcast(body.boardId, body.event);
    return Response.json({ ok: true, delivered });
  },
});

console.log(`websockets on ws://localhost:${WS_PORT}, internal broadcast on http://localhost:${WS_INTERNAL_PORT}`);
