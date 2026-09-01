import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Columns3, House, LayoutTemplate } from "lucide-react";

import { cn } from "@/lib/utils";
import { getOrganizations } from "@/lib/api";

/** One nav row. Colors come from tokens, never hardcoded hexes. */
const itemClass =
  "flex items-center gap-3 rounded-sm px-3 py-2 text-sm font-medium text-text-subtle transition-colors hover:bg-surface-subtle";

// Neutral, not brand blue: the palette is a grey ladder now, and a blue pill
// was the last Atlassian tint left in the chrome. One rung lighter than the
// hover colour, so selected and hovered stay distinguishable.
const activeClass = "bg-surface-hover text-text-strong font-semibold hover:bg-surface-hover";

export function AppSidebar() {
  // Same query key as the navbar — React Query serves both from one fetch.
  const { data: organizations } = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations, retry: false });

  // Selection is computed in one place rather than left to per-Link matching.
  // Home and Boards lead to the same route, so matchers alone lit both at once;
  // deriving all three from the same location makes "exactly one" enforceable.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const activeOrg = new URLSearchParams(searchStr).get("org");

  const onOverview = pathname === "/boards" && activeOrg === null;
  const onBoardDetail = pathname.startsWith("/boards/");

  return (
    <aside className="border-border-subtle w-56 shrink-0 border-r bg-surface px-3 py-4">
      <nav className="flex flex-col gap-0.5">
        {/* Home is the unfiltered overview of every workspace. */}
        <Link to="/boards" search={{}} className={cn(itemClass, onOverview && activeClass)}>
          <House className="size-4 shrink-0" />
          Home
        </Link>
        {/* Boards means "you are inside a board", so it lights only there. The
            two would otherwise both match /boards and light together. */}
        <Link to="/boards" className={cn(itemClass, onBoardDetail && activeClass)}>
          <Columns3 className="size-4 shrink-0" />
          Boards
        </Link>

        {/* No templates feature on the backend yet: shown, but inert on purpose. */}
        <span
          className={cn(itemClass, "text-text-subtlest cursor-not-allowed opacity-70 hover:bg-transparent")}
          aria-disabled
        >
          <LayoutTemplate className="size-4 shrink-0" />
          Templates
        </span>
      </nav>

      <div className="border-border-subtle my-4 border-t" />

      <p className="text-text-subtlest px-3 pb-2 text-xs font-semibold tracking-wide uppercase">Workspaces</p>

      {organizations?.length ? (
        <ul className="flex flex-col gap-0.5">
          {organizations.map((org) => (
            <li key={org.id}>
              <Link
                to="/boards"
                search={{ org: org.id }}
                className={cn(itemClass, "text-text-strong", activeOrg === org.id && activeClass)}
              >
                <WorkspaceAvatar name={org.name} />
                <span className="truncate">{org.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-text-subtlest px-3 text-sm">No workspaces yet.</p>
      )}
    </aside>
  );
}

export function WorkspaceAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-sm bg-linear-to-br from-[#4BCE97] to-[#1F845A] text-xs font-bold text-white",
        className,
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
