import { useDraggable } from "@dnd-kit/react";
import { useNavigate } from "@tanstack/react-router";
import { GitPullRequest, Square, SquareCheck } from "lucide-react";
import { useRef } from "react";

import type { Issue, SectionKind } from "@/lib/api";
import { ALLOWED } from "@/lib/board";
import { PRIORITY_MARK, avatarTint, initials, labelClass } from "@/lib/issue-style";
import { cn } from "@/lib/utils";

/**
 * One draggable card. `kind` is the column it sits in; it travels with the drag
 * as the draggable `type`. Clicking (without dragging) opens the issue page.
 *
 * The checkbox beside the key is "done": ticked when the card is in Done, and
 * ticking it moves the card there — `onMarkDone` is the board's move, or absent
 * when there is nowhere to move to (no Done column). Done is terminal for
 * people (ALLOWED.DONE is empty), so a ticked box cannot be unticked here.
 */
export function IssueCard({
  issue,
  kind,
  onMarkDone,
}: {
  issue: Issue;
  kind: SectionKind | null;
  onMarkDone?: () => void;
}) {
  const navigate = useNavigate();
  const locked = kind !== null && (ALLOWED[kind] ?? []).length === 0;
  const done = kind === "DONE";
  // Ticked, or nowhere to tick into: the box is then inert rather than
  // disabled. A disabled button swallows the click; an inert one lets it fall
  // through to the card, which opens the issue like the rest of it does.
  const inert = done || !onMarkDone;
  const domId = `card-${issue.id}`;

  const { ref, isDragging } = useDraggable({
    id: issue.id,
    type: kind ?? "custom",
    disabled: locked,
  });

  const open = () =>
    navigate({ to: "/boards/$boardId/issues/$issueId", params: { boardId: issue.boardId, issueId: issue.id } });

  // A card is both draggable and clickable. Releasing after a drag still emits
  // a click, so "did the pointer travel?" is what separates the two — measured
  // here rather than trusting the drag library to suppress the click.
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const DRAG_SLOP_PX = 5;

  return (
    <li
      ref={ref}
      id={domId}
      // A card is a control: it opens the issue. Keyboard users get the same
      // action without needing the pointer drag.
      role="button"
      tabIndex={0}
      // Named by its title and key alone. Without this the name is computed
      // from content, and the checkbox's label would leak into what the card
      // is announced as — an action the card itself never performs.
      aria-labelledby={`${domId}-title ${domId}-key`}
      onPointerDown={(e) => {
        pressedAt.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={(e) => {
        const from = pressedAt.current;
        pressedAt.current = null;
        if (!from) return;
        const travelled = Math.hypot(e.clientX - from.x, e.clientY - from.y);
        if (travelled <= DRAG_SLOP_PX) open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        "bg-surface text-text-strong flex flex-col gap-2 rounded-md px-3 py-2.5 text-sm",
        "shadow-[var(--shadow-e100)] transition-shadow hover:shadow-[var(--shadow-e200)]",
        "focus-visible:ring-brand focus-visible:ring-2 focus-visible:outline-none",
        locked ? "cursor-pointer" : "cursor-grab",
        isDragging && "opacity-50",
      )}
    >
      <span id={`${domId}-title`} className="leading-snug">
        {issue.title}
      </span>

      {issue.labels.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {issue.labels.map((label) => (
            <span
              key={label.id}
              className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold", labelClass(label.color))}
            >
              {label.name}
            </span>
          ))}
        </span>
      )}

      <span className="flex items-center gap-2">
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          // One name in both states; aria-checked carries the state.
          aria-label={`${issue.key} done`}
          title={done ? "Done" : "Mark as done"}
          aria-disabled={inert || undefined}
          tabIndex={inert ? -1 : 0}
          // The card around this box is itself a control: a click opens the
          // issue and a press starts a drag. dnd-kit already refuses to start a
          // drag from a nested button; the card's own click and key handlers
          // are stopped here so ticking the box is only ever ticking the box.
          // Once inert, nothing is stopped and pointer events pass through, so
          // the tick is just another part of the card to click.
          onPointerDown={inert ? undefined : (e) => e.stopPropagation()}
          onKeyDown={inert ? undefined : (e) => e.stopPropagation()}
          onClick={
            inert
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  onMarkDone?.();
                }
          }
          className={cn(
            "-my-0.5 -ml-0.5 flex size-5 shrink-0 items-center justify-center rounded transition-colors",
            "focus-visible:ring-brand focus-visible:ring-2 focus-visible:outline-none",
            inert && "pointer-events-none",
            done ? "text-success-text" : "text-text-subtlest hover:bg-surface-hover hover:text-text-strong",
          )}
        >
          {done ? <SquareCheck className="size-3.5" aria-hidden /> : <Square className="size-3.5" aria-hidden />}
        </button>
        <span id={`${domId}-key`} className="text-text-subtle text-[11px] font-medium">
          {issue.key}
        </span>

        {issue.githubNumber !== null && (
          <span className="text-text-subtlest inline-flex items-center gap-0.5 text-[11px]" title="Linked GitHub issue">
            <GitPullRequest className="size-3" />#{issue.githubNumber}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          {issue.priority && (
            <span
              className={cn("text-[11px] font-bold", PRIORITY_MARK[issue.priority].className)}
              title={`${PRIORITY_MARK[issue.priority].label} priority`}
            >
              {PRIORITY_MARK[issue.priority].glyph}
            </span>
          )}
          <span className="flex -space-x-1">
            {issue.assignees.slice(0, 3).map((user) => (
              <span
                key={user.id}
                title={user.email}
                className={cn(
                  "border-surface flex size-5 items-center justify-center rounded-full border text-[9px] font-bold text-white",
                  avatarTint(user.id),
                )}
              >
                {initials(user.email)}
              </span>
            ))}
          </span>
        </span>
      </span>
    </li>
  );
}
