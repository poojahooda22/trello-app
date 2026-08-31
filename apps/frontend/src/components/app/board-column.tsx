import { useDroppable } from "@dnd-kit/react";
import type { ReactNode } from "react";

import type { SectionKind } from "@/lib/api";
import { canMove, kindOf } from "@/lib/board";
import { cn } from "@/lib/utils";

/** One droppable column. Its own component so useDroppable runs once per column, below DragDropProvider. */
export function BoardColumn({ id, kind, children }: { id: string; kind: SectionKind | null; children: ReactNode }) {
  const { ref, isDropTarget } = useDroppable({
    id,
    accept: (source) => canMove(kindOf(source.type), kind),
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
