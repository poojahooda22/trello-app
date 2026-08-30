import { useDroppable } from "@dnd-kit/react";
import type { ReactNode } from "react";

import { canMove, isColumnKey, type ColumnKey } from "@/lib/board";
import { cn } from "@/lib/utils";

/**
 * One droppable column. It is its own component (not inline in the route) so
 * that `useDroppable` runs exactly once at the top of a component — React needs
 * a fixed hook count per component — and so the hook sits *below*
 * <DragDropProvider> in the tree and finds the provider's manager.
 */
export function BoardColumn({ id, children }: { id: ColumnKey; children: ReactNode }) {
  const { ref, isDropTarget } = useDroppable({
    id,
    accept: (source) => isColumnKey(source.type) && canMove(source.type, id),
  });

  return (
    <section
      ref={ref}
      className={cn(
        "bg-surface-subtle flex min-w-40 flex-1 basis-0 flex-col rounded-xl p-2 shadow-[var(--shadow-e100)]",
        isDropTarget && "ring-brand ring-2",
      )}
    >
      {children}
    </section>
  );
}
