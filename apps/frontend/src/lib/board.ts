import type { SectionKind } from "@/lib/api";

export const SECTION_KINDS = ["BACKLOG", "TODO", "INPROGRESS", "REVIEW", "DONE"] as const;

/** Where a card may be dragged, keyed by the kind it comes from. The backend enforces the same table. */
export const ALLOWED: Record<SectionKind, readonly SectionKind[]> = {
  BACKLOG: ["TODO"],
  TODO: ["BACKLOG", "INPROGRESS"],
  INPROGRESS: ["REVIEW"],
  REVIEW: ["INPROGRESS", "DONE"],
  DONE: [],
};

export function isSectionKind(value: unknown): value is SectionKind {
  return typeof value === "string" && (SECTION_KINDS as readonly string[]).includes(value);
}

/** dnd-kit carries the source column's kind as the draggable `type`; custom columns send "custom". */
export function kindOf(type: unknown): SectionKind | null {
  return isSectionKind(type) ? type : null;
}

/** Custom columns (no kind) accept and release anything. */
export function canMove(from: SectionKind | null, to: SectionKind | null): boolean {
  if (from === null || to === null || from === to) return true;
  return (ALLOWED[from] ?? []).includes(to);
}
