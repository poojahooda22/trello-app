import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { DragDropProvider } from "@dnd-kit/react";
import { GitPullRequest, Hash, Plus, Settings, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AppNavbar } from "@/components/app/app-navbar";
import { AppSidebar } from "@/components/app/app-sidebar";
import { BoardColumn } from "@/components/app/board-column";
import { IssueCard } from "@/components/app/issue-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createIssue,
  getBoards,
  getIntegrations,
  getOrganizations,
  getSections,
  moveIssue,
  type BoardData,
  type Issue,
  type Section,
} from "@/lib/api";
import { canMove } from "@/lib/board";
import { playDropSound } from "@/lib/sound";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/boards/$boardId")({
  component: BoardDetail,
});

/** Real identity from the room token — the relay shows people, not random ids. */
type PresentUser = { id: string; email: string };

/** What the backend pushes through the socket relay after each committed write. */
type BoardEvent =
  | { type: "issue_added" | "issue_moved" | "issue_updated"; issue: Issue }
  | { type: "issue_deleted"; issueId: string };

/**
 * Pure and idempotent. Issue versions make it safe under reordered delivery:
 * an event older than what the cache already holds is dropped.
 */
function applyEvent(sections: Section[], event: BoardEvent): Section[] {
  if (event.type === "issue_deleted") {
    return sections.map((s) => ({ ...s, issues: s.issues.filter((i) => i.id !== event.issueId) }));
  }
  const issue = event.issue;
  const existing = sections.flatMap((s) => s.issues).find((i) => i.id === issue.id);
  if (existing && existing.version > issue.version) return sections;
  return sections.map((s) => {
    const without = s.issues.filter((i) => i.id !== issue.id);
    if (s.id !== issue.sectionId) return without.length === s.issues.length ? s : { ...s, issues: without };
    return { ...s, issues: [...without, issue].sort((a, b) => a.position - b.position || a.number - b.number) };
  });
}

function BoardDetail() {
  const { boardId } = Route.useParams();
  const queryClient = useQueryClient();
  const sectionsKey = ["sections", boardId] as const;

  const { data, isPending, isError, error } = useQuery({
    queryKey: sectionsKey,
    queryFn: () => getSections(boardId),
  });
  const sections = data?.sections ?? [];

  // The freshest room token, readable from the (re)connect logic without
  // retriggering the socket effect on every refetch.
  const roomTokenRef = useRef<string | null>(null);
  if (data?.roomToken) roomTokenRef.current = data.roomToken;
  const hasToken = Boolean(data?.roomToken);

  function patchIssue(issue: Issue, type: "issue_added" | "issue_moved" | "issue_updated" = "issue_moved") {
    queryClient.setQueryData<BoardData>(sectionsKey, (prev) => prev && { ...prev, sections: applyEvent(prev.sections, { type, issue }) });
  }

  const create = useMutation({
    mutationFn: createIssue,
    onSuccess: (issue) => patchIssue(issue, "issue_added"),
  });

  const move = useMutation({
    mutationFn: moveIssue,
    onSuccess: (issue) => patchIssue(issue),
  });

  function handleDrop(issue: Issue, toSectionId: string) {
    void playDropSound();
    // Synchronous optimistic placement; the version is deliberately unchanged
    // so the server's echo (version + 1) corrects the provisional position.
    patchIssue({ ...issue, sectionId: toSectionId, position: Number.MAX_SAFE_INTEGER });
    move.mutate(
      { issueId: issue.id, sectionId: toSectionId },
      {
        onError: () => {
          patchIssue(issue); // back to the last server-confirmed place
          void queryClient.invalidateQueries({ queryKey: sectionsKey });
        },
      },
    );
  }

  const [users, setUsers] = useState<PresentUser[]>([]);
  const [title, setTitle] = useState("");
  const [composingId, setComposingId] = useState<string | null>(null);

  useEffect(() => {
    if (!hasToken) return;
    const key = ["sections", boardId] as const;
    let cancelled = false;
    let attempt = 0;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      if (cancelled) return;
      // wss:// in production — a browser on an https page refuses ws://.
      ws = new WebSocket(process.env.BUN_PUBLIC_WS_URL);
      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: "join", boardId, token: roomTokenRef.current }));
        if (attempt > 0) {
          // Reconnected: refetch what was missed (this also renews the token).
          void queryClient.invalidateQueries({ queryKey: key });
        }
        attempt = 0;
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        switch (msg.type) {
          case "initial_state":
            setUsers(msg.users ?? []);
            break;
          case "join":
            setUsers((u) => (u.some((x) => x.id === msg.user.id) ? u : [...u, msg.user]));
            break;
          case "leave":
            setUsers((u) => u.filter((x) => x.id !== msg.userId));
            break;
          case "issue_added":
          case "issue_moved":
          case "issue_updated":
          case "issue_deleted": {
            const current = queryClient.getQueryData<BoardData>(key);
            const unknownSection =
              current && "issue" in msg && !current.sections.some((s) => s.id === msg.issue.sectionId);
            if (!current || unknownSection) {
              // Nothing loaded yet, or a column this tab has not seen: resync.
              void queryClient.invalidateQueries({ queryKey: key });
              break;
            }
            queryClient.setQueryData<BoardData>(key, { ...current, sections: applyEvent(current.sections, msg) });
            break;
          }
          case "section_added":
          case "section_updated":
          case "section_deleted":
            void queryClient.invalidateQueries({ queryKey: key });
            break;
        }
      };
      ws.onclose = (ev) => {
        setUsers([]);
        if (cancelled) return;
        // 4001 = room token rejected; fetch a fresh one before retrying.
        if (ev.code === 4001) void queryClient.invalidateQueries({ queryKey: key });
        timer = setTimeout(connect, Math.min(15_000, 1_000 * 2 ** attempt));
        attempt += 1;
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [boardId, hasToken, queryClient]);

  const { data: organizations } = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations, retry: false });
  const boardQueries = useQueries({
    queries: (organizations ?? []).map((org) => ({
      queryKey: ["boards", org.id],
      queryFn: () => getBoards(org.id),
    })),
  });
  const board = boardQueries.flatMap((q) => q.data ?? []).find((b) => b.id === boardId);
  const workspace = organizations?.find((o) => o.id === board?.organizationId);

  // Badges in the header so the whole team can see what this board is wired to.
  const { data: integrations } = useQuery({
    queryKey: ["integrations", boardId],
    queryFn: () => getIntegrations(boardId),
  });
  const connected = (integrations ?? []).filter((i) => i.connected);

  function addIssue(sectionId: string) {
    if (!title.trim()) return;
    create.mutate({ sectionId, title: title.trim() });
    setTitle("");
  }

  return (
    <div className="bg-surface-sunken flex min-h-dvh flex-col">
      <AppNavbar />

      <div className="flex min-h-0 flex-1">
        <AppSidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="border-border-subtle bg-surface flex shrink-0 items-center gap-3 border-b px-6 py-3">
            <div className="min-w-0">
              <h1 className="text-text-strong truncate text-lg font-semibold">
                {board?.title ?? "Board " + boardId.slice(0, 8)}
              </h1>
              {workspace && <p className="text-text-subtlest truncate text-xs">{workspace.name}</p>}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {connected.map((i) => (
                <Link
                  key={i.provider}
                  to="/boards/$boardId/settings"
                  params={{ boardId }}
                  title={
                    i.lastError
                      ? `${i.provider}: ${i.lastError}`
                      : `${i.provider}${i.label ? ` · ${i.label}` : ""}${i.enabled ? "" : " (paused)"}`
                  }
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium transition-colors",
                    i.lastError
                      ? "bg-destructive/10 text-destructive"
                      : i.enabled
                        ? "bg-surface-subtle text-text-subtle hover:bg-surface-hover"
                        : "bg-surface-subtle text-text-subtlest hover:bg-surface-hover",
                  )}
                >
                  {i.provider === "SLACK" ? <Hash className="size-3.5" /> : <GitPullRequest className="size-3.5" />}
                  <span className="max-w-28 truncate">{i.label ?? (i.provider === "SLACK" ? "Slack" : "GitHub")}</span>
                </Link>
              ))}

              <Link
                to="/boards/$boardId/issues"
                params={{ boardId }}
                className="text-text-subtle hover:bg-surface-hover rounded-md px-2 py-1.5 text-sm font-medium transition-colors"
              >
                Issues
              </Link>

              <Link
                to="/boards/$boardId/settings"
                params={{ boardId }}
                aria-label="Board settings"
                title="Board settings"
                className="text-text-subtle hover:bg-surface-hover flex size-8 items-center justify-center rounded-md transition-colors"
              >
                <Settings className="size-4" />
              </Link>

              <div className="flex -space-x-1.5">
                {users.slice(0, 5).map((u) => (
                  <span
                    key={u.id}
                    title={u.email}
                    className="border-surface bg-brand flex size-7 items-center justify-center rounded-full border-2 text-[10px] font-bold text-white"
                  >
                    {u.email.slice(0, 2).toUpperCase()}
                  </span>
                ))}
              </div>
              <span className="text-text-subtlest text-xs">
                {users.length === 0 ? "Only you" : users.length + " other" + (users.length === 1 ? "" : "s") + " here"}
              </span>
            </div>
          </header>

          {isPending && <p className="text-text-subtlest p-4 text-sm">Loading board…</p>}
          {isError && <p className="text-destructive p-4 text-sm">{error.message}</p>}
          {(create.isError || move.isError) && (
            <p className="text-destructive px-4 pt-3 text-sm">{(create.error ?? move.error)?.message}</p>
          )}

          <DragDropProvider
            onDragEnd={(event) => {
              if (event.canceled) return;
              const { source, target } = event.operation;
              if (!source || !target) return;

              const issueId = String(source.id);
              const to = sections.find((s) => s.id === String(target.id));
              const from = sections.find((s) => s.issues.some((i) => i.id === issueId));
              const issue = from?.issues.find((i) => i.id === issueId);
              if (!to || !from || !issue || to.id === from.id || !canMove(from.kind, to.kind)) return;

              handleDrop(issue, to.id);
            }}
          >
            <div className="flex flex-1 items-start gap-3 overflow-x-auto p-4">
              {sections.map((section) => {
                const isComposing = composingId === section.id;

                return (
                  <BoardColumn key={section.id} id={section.id} kind={section.kind}>
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <h2 className="text-text-strong text-sm font-semibold">{section.title}</h2>
                      <span className="text-text-subtlest text-xs">{section.issues.length}</span>
                    </div>

                    <ul className="flex flex-col gap-2 px-0.5 pb-1">
                      {section.issues.map((issue) => (
                        <IssueCard key={issue.id} issue={issue} kind={section.kind} />
                      ))}
                    </ul>

                    {isComposing ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          addIssue(section.id);
                          setComposingId(null);
                        }}
                        className="flex flex-col gap-2 p-1"
                      >
                        <Input
                          autoFocus
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder="Enter a title"
                          className="bg-surface h-9 text-sm"
                        />
                        <div className="flex gap-1.5">
                          <Button
                            type="submit"
                            size="sm"
                            disabled={create.isPending}
                            className="bg-brand hover:bg-brand-hover h-8 flex-1 text-xs font-semibold text-white"
                          >
                            Add issue
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Cancel"
                            onClick={() => setComposingId(null)}
                            className="size-8 shrink-0"
                          >
                            <X className="size-3.5" />
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setTitle("");
                          setComposingId(section.id);
                        }}
                        className={cn(
                          "text-text-subtle hover:bg-surface-hover flex items-center gap-1.5 rounded-md px-2 py-2",
                          "text-sm font-medium transition-colors",
                        )}
                      >
                        <Plus className="size-4" />
                        Add a card
                      </button>
                    )}
                  </BoardColumn>
                );
              })}
            </div>
          </DragDropProvider>
        </main>
      </div>
    </div>
  );
}
