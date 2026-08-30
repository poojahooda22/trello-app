export type ColumnKey = "backlog" | "todo" | "inprogress" | "review" | "done";

/** A card. `key` (TRL-42) is what goes in a branch name so GitHub can find it. */
export type Issue = { id: string; key: string; title: string; sectionId: ColumnKey; position: number };

/** The columns, left to right, in workflow order. */
export const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "backlog", label: "Backlog" },
  { key: "todo", label: "To Do" },
  { key: "inprogress", label: "In Progress" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];

/**
 * Which columns a card may be dragged INTO, keyed by the column it comes FROM.
 * This is the whole workflow rule in one place:
 *   backlog → todo → inprogress → review → done, with review able to send a
 *   card back to inprogress (changes requested). Done is final.
 * Want "reopen"? Add "inprogress" to the `done` row — nothing else changes.
 */
export const ALLOWED: Record<ColumnKey, readonly ColumnKey[]> = {
  backlog: ["todo", "inprogress"], 
  todo: ["backlog", "inprogress"],
  inprogress: ["review", "backlog"],
  review: ["done", "backlog"],
  done: [],
};

/** Narrows an unknown value (a dnd-kit id or type) to a ColumnKey. */
export function isColumnKey(value: unknown): value is ColumnKey {
  return COLUMNS.some((c) => c.key === value);
}

export function canMove(from: ColumnKey, to: ColumnKey): boolean {
  return ALLOWED[from].includes(to);
}
