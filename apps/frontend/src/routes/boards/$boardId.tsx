import { createFileRoute } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { DragDropProvider } from "@dnd-kit/react";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AppNavbar } from "@/components/app/app-navbar";
import { AppSidebar } from "@/components/app/app-sidebar";
import { BoardColumn } from "@/components/app/board-column";
import { IssueCard } from "@/components/app/issue-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getBoards, getOrganizations } from "@/lib/api";
import { COLUMNS, canMove, isColumnKey, type ColumnKey, type Issue } from "@/lib/board";
import { playDropSound } from "@/lib/sound";
import { cn } from "@/lib/utils";


export const Route = createFileRoute("/boards/$boardId")({
  component: BoardDetail,
});

type PresentUser = { id: string };

function BoardDetail() {
  const { boardId } = Route.useParams();

  const [users, setUsers] = useState<PresentUser[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const [title, setTitle] = useState("");

  function send(message: unknown) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  function addIssue(sectionId: ColumnKey) {
    if (!title.trim()) return;
    send({ type: "issue_added", boardId, sectionId, title: title.trim() });
    setTitle(""); 
  }

  function moveIssue(issueId: Issue["id"], from: ColumnKey, to: ColumnKey) {
    if (from === to || !canMove(from, to)) return;
    void playDropSound(); 
    setIssues((prev) => prev.map((i) => (i.id === issueId ? { ...i, sectionId: to } : i)));
    send({ type: "issue_moved", boardId, issueId, sectionId: to });
  }

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:3002");
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", boardId }));
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.type) {
        case "initial_state":
          setUsers(msg.users ?? []);
          setIssues(msg.issues ?? []);
          break;

        case "join":
          setUsers((u) => [...u, { id: msg.userId }]);
          break;

        case "leave":
          setUsers((u) => u.filter((x) => x.id !== msg.userId));
          break;

        case "issue_added":
          setIssues((prev) => [...prev, msg.issue]);
          break;

        case "issue_moved":
          setIssues((prev) =>
            prev.map((i) =>
              i.id === msg.issue.id ? { ...i, sectionId: msg.issue.sectionId, position: msg.issue.position } : i,
            ),
          );
          break;
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [boardId]);

  const [composingKey, setComposingKey] = useState<ColumnKey | null>(null);

  const { data: organizations } = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations, retry: false });
  const boardQueries = useQueries({
    queries: (organizations ?? []).map((org) => ({
      queryKey: ["boards", org.id],
      queryFn: () => getBoards(org.id),
    })),
  });
  const board = boardQueries.flatMap((q) => q.data ?? []).find((b) => b.id === boardId);
  const workspace = organizations?.find((o) => o.id === board?.organizationId);

  return (
    <div className="bg-surface-sunken flex min-h-dvh flex-col">
      <AppNavbar />

      <div className="flex min-h-0 flex-1">
        <AppSidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          {/* Board header */}
          <header className="border-border-subtle bg-surface flex shrink-0 items-center gap-3 border-b px-6 py-3">
            <div className="min-w-0">
              <h1 className="text-text-strong truncate text-lg font-semibold">
                {board?.title ?? "Board " + boardId.slice(0, 8)}
              </h1>
              {workspace && <p className="text-text-subtlest truncate text-xs">{workspace.name}</p>}
            </div>

            {/* Presence: your `users` state, rendered as avatars. */}
            <div className="ml-auto flex items-center gap-2">
              <div className="flex -space-x-1.5">
                {users.slice(0, 5).map((u) => (
                  <span
                    key={u.id}
                    title={String(u.id)}
                    className="border-surface bg-brand flex size-7 items-center justify-center rounded-full border-2 text-[10px] font-bold text-white"
                  >
                    {String(u.id).slice(0, 2).toUpperCase()}
                  </span>
                ))}
              </div>
              <span className="text-text-subtlest text-xs">
                {users.length === 0 ? "Only you" : users.length + " other" + (users.length === 1 ? "" : "s") + " here"}
              </span>
            </div>
          </header>

          {/* Columns. Horizontal scroll so extra lists never squash the existing ones. */}
          <DragDropProvider
            onDragEnd={(event) => {
              if (event.canceled) return;
              const { source, target } = event.operation;
              // No target: dropped outside every column, or on a column whose
              // `accept` rejected this card (see BoardColumn).
              if (!source || !target) return;

              const from = source.type; // set by IssueCard: the column it came from
              const to = target.id; // set by BoardColumn: the column it landed on
              if (!isColumnKey(from) || !isColumnKey(to)) return;

              moveIssue(String(source.id), from, to);
            }}
          >
            <div className="flex flex-1 items-start gap-3 overflow-x-auto p-4">
              {COLUMNS.map((col) => {
                const cards = issues.filter((i) => i.sectionId === col.key);
                const isComposing = composingKey === col.key;

                return (
                  <BoardColumn key={col.key} id={col.key}>
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <h2 className="text-text-strong text-sm font-semibold">{col.label}</h2>
                      <span className="text-text-subtlest text-xs">{cards.length}</span>
                    </div>

                    <ul className="flex flex-col gap-2 px-0.5 pb-1">
                      {cards.map((issue) => (
                        <IssueCard key={issue.id} issue={issue} />
                      ))}
                    </ul>

                    {isComposing ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          addIssue(col.key);
                          setComposingKey(null);
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
                            className="bg-brand hover:bg-brand-hover h-8 flex-1 text-xs font-semibold text-white"
                          >
                            Add issue
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Cancel"
                            onClick={() => setComposingKey(null)}
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
                          setComposingKey(col.key);
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

