import { cn } from "@/lib/utils";

/** The Trello glyph. Shared by the auth pages and the app navbar. */
export function TrelloMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className={cn("size-9", className)}>
      <rect width="40" height="40" rx="8" fill="#1868DB" />
      <rect x="8" y="8" width="10" height="24" rx="2.5" fill="white" />
      <rect x="22" y="8" width="10" height="15" rx="2.5" fill="white" />
    </svg>
  );
}
