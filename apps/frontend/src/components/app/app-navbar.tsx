import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut, Search, Settings, User } from "lucide-react";

import { TrelloMark } from "@/components/app/trello-mark";
import { UserAvatar } from "@/components/app/user-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { me } from "@/lib/api";

export function AppNavbar() {
  const navigate = useNavigate();

  // Shared cache key with the sidebar: both read the same single request.
  const { data: user } = useQuery({ queryKey: ["me"], queryFn: me, retry: false });

  function handleLogout() {
    localStorage.removeItem("token");
    navigate({ to: "/signin" });
  }

  return (
    <header className="border-border-subtle bg-surface sticky top-0 z-40 flex h-14 shrink-0 items-center gap-4 border-b px-4">
      <Link to="/boards" className="flex shrink-0 items-center gap-1.5">
        <TrelloMark className="size-6" />
        <span className="text-text-strong text-lg font-bold tracking-tight">Trello</span>
      </Link>

      {/* Presentational for now — there is no search endpoint on the backend yet. */}
      <div className="relative mx-auto w-full max-w-xl">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input type="search" placeholder="Search" aria-label="Search" className="bg-surface-sunken focus-visible:bg-surface h-9 rounded-md pl-8 text-sm" />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Account menu"
          className="focus-visible:ring-ring/50 flex size-8 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]"
        >
          {user?.email ? (
            <UserAvatar email={user.email} px={32} title="Account menu" />
          ) : (
            // Before /me resolves there is no email to derive anything from.
            <span className="bg-surface-subtle text-text-subtlest flex size-8 items-center justify-center rounded-full">
              <User className="size-4" />
            </span>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-muted-foreground truncate text-xs font-normal">
            {user?.email ?? "Signed in"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>
            <Settings />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleLogout}>
            <LogOut />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
