import { useDraggable } from "@dnd-kit/react";

import { ALLOWED, type Issue } from "@/lib/board";
import { cn } from "@/lib/utils";

/** One draggable card. Same reason for being its own component as BoardColumn. */
export function IssueCard({ issue }: { issue: Issue }) {
  // A card with no allowed destination (Done) should not offer a drag at all.
  const locked = ALLOWED[issue.sectionId].length === 0;

  const { ref, isDragging } = useDraggable({
    id: issue.id,
    // `type` travels with the drag. BoardColumn's `accept` and the route's
    // onDragEnd both read it as "the column this card came from".
    type: issue.sectionId,
    disabled: locked,
  });

  return (
    <>
      <li
        ref={ref}
        className={cn(
          "bg-surface text-text-strong rounded-md px-3 py-2 text-sm shadow-[var(--shadow-e100)] transition-shadow hover:shadow-[var(--shadow-e200)]",
          locked ? "cursor-default" : "cursor-grab",
          isDragging && "opacity-50",
        )}
      >
        <span className="text-text-subtlest mb-0.5 block text-[11px] font-medium">{issue.key}</span>
        {issue.title}
      </li>
    </>
  );
}
