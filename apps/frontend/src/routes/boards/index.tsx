/** src/routes/boards/index.tsx -> "/boards" */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useState } from "react";

import { AppNavbar } from "@/components/app/app-navbar";
import { AppSidebar, WorkspaceAvatar } from "@/components/app/app-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { createBoard, createOrganization, getBoards, getOrganizations, type Organization } from "@/lib/api";

export const Route = createFileRoute("/boards/")({
  component: BoardsPage,
});

/** Deterministic tile gradient, so a board keeps the same colour between visits. */
const TILE_GRADIENTS = [
  "from-[#0055CC] to-[#1558BC]",
  "from-[#5E4DB2] to-[#352C63]",
  "from-[#216E4E] to-[#164B35]",
  "from-[#A54800] to-[#702E00]",
  "from-[#943D73] to-[#50253F]",
  "from-[#206A83] to-[#164555]",
];

function gradientFor(id: string) {
  let sum = 0;
  for (const ch of id) sum += ch.charCodeAt(0);
  return TILE_GRADIENTS[sum % TILE_GRADIENTS.length];
}

function BoardsPage() {
  const queryClient = useQueryClient();

  const {
    data: organizations,
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
    retry: false,
  });

  const create = useMutation({
    mutationFn: createOrganization,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["organizations"] }),
  });

  const [name, setName] = useState("");

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({ name: name.trim() }, { onSuccess: () => setName("") });
  }

  return (
    <div className="bg-surface-sunken flex min-h-dvh flex-col">
      <AppNavbar />

      <div className="flex flex-1">
        <AppSidebar />

        <main className="flex-1 px-10 py-8">
          <div className="mx-auto max-w-5xl">
            <h1 className="text-text-subtlest pb-4 text-xs font-bold tracking-wider uppercase">Your workspaces</h1>

            <form onSubmit={handleCreate} className="flex max-w-md gap-2 pb-8">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="New workspace name"
                className="bg-surface h-9"
              />
              <Button
                type="submit"
                disabled={create.isPending}
                className="bg-brand hover:bg-brand-hover h-9 shrink-0 font-semibold text-white"
              >
                {create.isPending ? "Creating…" : "Create workspace"}
              </Button>
            </form>

            {create.isError && <p className="text-destructive pb-4 text-sm">{create.error.message}</p>}

            {isPending && <p className="text-text-subtlest text-sm">Loading…</p>}

            {isError && (
              <p className="text-destructive text-sm">
                {error.message} —{" "}
                <Link to="/signin" className="underline">
                  sign in again
                </Link>
              </p>
            )}

            {organizations &&
              (organizations.length ? (
                <div className="flex flex-col gap-10">
                  {organizations.map((org) => (
                    <Workspace key={org.id} org={org} />
                  ))}
                </div>
              ) : (
                <p className="text-text-subtlest text-sm">No workspaces yet — create one above.</p>
              ))}
          </div>
        </main>
      </div>
    </div>
  );
}

function Workspace({ org }: { org: Organization }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [composing, setComposing] = useState(false);

  const { data: boards, isPending, isError, error } = useQuery({
    queryKey: ["boards", org.id],
    queryFn: () => getBoards(org.id),
  });

  const create = useMutation({
    mutationFn: createBoard,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["boards", org.id] });
      setTitle("");
      setComposing(false);
    },
  });

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) return;
    create.mutate({ orgId: org.id, title: title.trim() });
  }

  return (
    <section>
      <div className="flex items-center gap-2.5 pb-4">
        <WorkspaceAvatar name={org.name} className="size-8 rounded-md text-sm" />
        <h2 className="text-text-strong font-semibold">{org.name}</h2>
        <span className="bg-surface-subtle text-text-subtlest rounded-sm px-1.5 py-0.5 text-[10px] font-bold tracking-wide">
          {org.role}
        </span>
      </div>

      {isPending && <p className="text-text-subtlest text-sm">Loading boards…</p>}
      {isError && <p className="text-destructive text-sm">{error.message}</p>}

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] gap-4">
        {boards?.map((board) => (
          <li key={board.id}>
            <Link
              to="/boards/$boardId"
              params={{ boardId: board.id }}
              className={cn(
                "group relative flex h-24 flex-col justify-end overflow-hidden rounded-md bg-linear-to-br p-3",
                "shadow-[var(--shadow-e100)] transition-shadow hover:shadow-[var(--shadow-e200)]",
                gradientFor(board.id),
              )}
            >
              {/* Scrim keeps the title legible on the lighter gradients. */}
              <span className="absolute inset-0 bg-linear-to-t from-black/25 to-transparent transition-opacity group-hover:opacity-60" />
              <span className="relative truncate text-sm font-semibold text-white">{board.title}</span>
            </Link>
          </li>
        ))}

        <li>
          {composing ? (
            <form
              onSubmit={handleCreate}
              className="bg-surface border-border-subtle flex h-24 flex-col justify-center gap-2 rounded-md border p-3 shadow-[var(--shadow-e100)]"
            >
              <Input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Board title"
                className="h-8 text-sm"
              />
              <div className="flex gap-1.5">
                <Button
                  type="submit"
                  size="sm"
                  disabled={create.isPending}
                  className="bg-brand hover:bg-brand-hover h-7 flex-1 text-xs font-semibold text-white"
                >
                  {create.isPending ? "Creating…" : "Create"}
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Cancel"
                  onClick={() => setComposing(false)}
                  className="size-7 shrink-0"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setComposing(true)}
              className="bg-surface-subtle hover:bg-surface-hover text-text-subtle flex h-24 w-full items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors"
            >
              <Plus className="size-4" />
              Create new board
            </button>
          )}
        </li>
      </ul>

      {create.isError && <p className="text-destructive pt-2 text-sm">{create.error.message}</p>}
    </section>
  );
}
