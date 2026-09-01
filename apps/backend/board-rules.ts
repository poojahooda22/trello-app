/** Board vocabulary shared by the routes and the GitHub webhook. Pure: no I/O. */

export const SECTION_KINDS = ["BACKLOG", "TODO", "INPROGRESS", "REVIEW", "DONE"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const DEFAULT_SECTIONS: { kind: SectionKind; title: string }[] = [
  { kind: "BACKLOG", title: "Backlog" },
  { kind: "TODO", title: "To Do" },
  { kind: "INPROGRESS", title: "In Progress" },
  { kind: "REVIEW", title: "Review" },
  { kind: "DONE", title: "Done" },
];

/** Where a card may be dragged, keyed by the kind it comes from. Mirrored in apps/frontend/src/lib/board.ts. */
export const ALLOWED: Record<SectionKind, readonly SectionKind[]> = {
  BACKLOG: ["TODO", "INPROGRESS", "REVIEW", "DONE"],
  TODO: ["BACKLOG", "INPROGRESS", "REVIEW", "DONE"],
  INPROGRESS: ["REVIEW", "BACKLOG", "DONE", "TODO"],
  REVIEW: ["INPROGRESS", "DONE",  "BACKLOG", "TODO"],
  DONE: [],
};

export function isSectionKind(value: unknown): value is SectionKind {
  return typeof value === "string" && (SECTION_KINDS as readonly string[]).includes(value);
}

/** Custom columns (no kind) accept and release anything; same column = reorder. */
export function canMove(from: SectionKind | null, to: SectionKind | null): boolean {
  if (from === null || to === null || from === to) return true;
  return ALLOWED[from].includes(to);
}

/**
 * "Zepto Board" → "ZEP". Leading digits are stripped because the key parser
 * requires a letter first. Kept in sync with the SQL in the phase0 migrations.
 */
export function keyPrefixFor(title: string): string {
  const cleaned = title.replace(/[^A-Za-z0-9]/g, "").replace(/^[0-9]+/, "").toUpperCase();
  return cleaned.length >= 2 ? cleaned.slice(0, 3) : "BRD";
}

export const issueKey = (prefix: string, number: number) => `${prefix}-${number}`;

const KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,4})-(\d+)\b/i;

/** "feat/ZEP-7-login" → { prefix: "ZEP", number: 7 }. */
export function parseIssueKey(text: string | undefined): { prefix: string; number: number } | null {
  const match = text?.match(KEY_PATTERN);
  return match ? { prefix: match[1]!.toUpperCase(), number: Number(match[2]) } : null;
}

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The colors a label may use; the UI maps each name to its palette. */
export const LABEL_COLORS = ["grey", "blue", "green", "yellow", "orange", "red", "purple"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export type LabelDto = { id: string; name: string; color: string };
export type UserRef = { id: string; email: string };

/** The issue shape every route returns and every socket event carries. */
export type IssueDto = {
  id: string;
  key: string;
  number: number;
  title: string;
  description: string | null;
  position: number;
  sectionId: string;
  boardId: string;
  /** Bumped on every write; clients drop events older than what they hold. */
  version: number;
  /** The GitHub issue this card mirrors, if the board has a linked repository. */
  githubNumber: number | null;
  priority: Priority | null;
  assignees: UserRef[];
  labels: LabelDto[];
};
