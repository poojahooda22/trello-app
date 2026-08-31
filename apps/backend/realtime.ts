import { createHmac } from "node:crypto";

import type { IssueDto, SectionKind } from "./board-rules";

const WS_INTERNAL_URL = process.env.WS_INTERNAL_URL ?? "http://localhost:3003";
const WS_INTERNAL_TOKEN = process.env.WS_INTERNAL_TOKEN;
if (!WS_INTERNAL_TOKEN) {
  console.warn("WS_INTERNAL_TOKEN not set — board changes will not reach open tabs live.");
}

export type SectionDto = { id: string; title: string; kind: SectionKind | null; position: number; boardId: string };

export type BoardEvent =
  | { type: "issue_added"; issue: IssueDto }
  | { type: "issue_moved"; issue: IssueDto }
  | { type: "issue_updated"; issue: IssueDto }
  | { type: "issue_deleted"; issueId: string }
  | { type: "section_added"; section: SectionDto }
  | { type: "section_updated"; section: SectionDto }
  | { type: "section_deleted"; sectionId: string };

const ROOM_TOKEN_TTL_MS = 15 * 60 * 1000;

export type RoomUser = { id: string; email: string };

/**
 * Proof of board membership AND identity for the socket relay: issued only
 * after requireMember passed, so presence shows real users, not random ids.
 * Format: base64url(JSON{boardId, user, exp}) + "." + HMAC(payload) — the
 * relay verifies it with the same shared secret and never touches the DB.
 */
export function mintRoomToken(boardId: string, user: RoomUser): string {
  if (!WS_INTERNAL_TOKEN) return "";
  const payload = Buffer.from(
    JSON.stringify({ boardId, user, exp: Date.now() + ROOM_TOKEN_TTL_MS }),
  ).toString("base64url");
  const signature = createHmac("sha256", WS_INTERNAL_TOKEN).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

/**
 * Tell every open tab of a board about a committed change. The database write
 * already happened; a failure here only means tabs are stale until reload, so
 * it is logged rather than thrown into the request.
 */
export function publish(boardId: string, event: BoardEvent): void {
  if (!WS_INTERNAL_TOKEN) return;
  fetch(`${WS_INTERNAL_URL}/internal/broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${WS_INTERNAL_TOKEN}` },
    body: JSON.stringify({ boardId, event }),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`socket server answered ${res.status}: ${await res.text()}`);
    })
    .catch((err) => console.error(`[realtime] ${event.type} for board ${boardId} not delivered:`, err));
}
