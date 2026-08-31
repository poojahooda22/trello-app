/** src/routes/boards/$boardId_.issues.$issueId.tsx -> "/boards/$boardId/issues/$issueId" */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Hash, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { AppNavbar } from "@/components/app/app-navbar";
import { AppSidebar } from "@/components/app/app-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  PRIORITIES,
  addAssignee,
  addComment,
  addLabel,
  createLabel,
  deleteIssue,
  getIntegrations,
  getIssue,
  getLabels,
  getMembers,
  removeAssignee,
  removeLabel,
  updateIssue,
  type IssueDetail,
  type Priority,
} from "@/lib/api";
import { PRIORITY_MARK, avatarTint, initials, labelClass } from "@/lib/issue-style";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/boards/$boardId_/issues/$issueId")({
  component: IssuePage,
});

function IssuePage() {
  const { boardId, issueId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const key = ["issue", issueId] as const;

  const { data: issue, isPending, isError, error } = useQuery({ queryKey: key, queryFn: () => getIssue(issueId) });

  // Refresh the board behind this page, so a change here shows there on return.
  const refreshBoard = () => queryClient.invalidateQueries({ queryKey: ["sections", boardId] });
  const setIssue = (next: IssueDetail) => queryClient.setQueryData(key, next);
  /** Field mutations return the card, not the detail: merge rather than replace. */
  const mergeIssue = (patch: Partial<IssueDetail>) => {
    const current = queryClient.getQueryData<IssueDetail>(key);
    if (current) setIssue({ ...current, ...patch });
    void refreshBoard();
  };

  return (
    <div className="bg-surface-sunken flex min-h-dvh flex-col">
      <AppNavbar />

      <div className="flex min-h-0 flex-1">
        <AppSidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="border-border-subtle bg-surface flex shrink-0 items-center gap-3 border-b px-6 py-3">
            <Link
              to="/boards/$boardId"
              params={{ boardId }}
              className="text-text-subtle hover:bg-surface-hover flex size-8 items-center justify-center rounded-md transition-colors"
              aria-label="Back to board"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div className="min-w-0">
              <h1 className="text-text-strong truncate text-lg font-semibold">{issue?.key ?? "Issue"}</h1>
              <p className="text-text-subtlest truncate text-xs">
                {issue?.boardTitle} · {issue?.section.title}
              </p>
            </div>
            <Link
              to="/boards/$boardId/issues"
              params={{ boardId }}
              className="text-text-subtle hover:bg-surface-hover ml-auto rounded-md px-2 py-1.5 text-sm font-medium transition-colors"
            >
              All issues
            </Link>
          </header>

          {isPending && <p className="text-text-subtlest p-6 text-sm">Loading…</p>}
          {isError && <p className="text-destructive p-6 text-sm">{error.message}</p>}

          {issue && (
            <div className="mx-auto grid w-full max-w-5xl gap-6 px-6 py-8 lg:grid-cols-[1fr_18rem]">
              <div className="flex min-w-0 flex-col gap-6">
                <TitleAndDescription issue={issue} onSaved={mergeIssue} />
                <Comments issue={issue} onAdded={(c) => setIssue({ ...issue, comments: [...issue.comments, c] })} />
              </div>

              <aside className="flex flex-col gap-5">
                <PrioritySelect issue={issue} onSaved={mergeIssue} />
                <Assignees issue={issue} onSaved={mergeIssue} />
                <Labels issue={issue} boardId={boardId} onSaved={mergeIssue} />
                <Links issue={issue} boardId={boardId} />
                <DangerZone
                  issue={issue}
                  onDeleted={() => {
                    void refreshBoard();
                    void navigate({ to: "/boards/$boardId", params: { boardId } });
                  }}
                />
              </aside>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-text-subtlest text-xs font-bold tracking-wide uppercase">{title}</h2>
      {children}
    </section>
  );
}

function TitleAndDescription({ issue, onSaved }: { issue: IssueDetail; onSaved: (patch: Partial<IssueDetail>) => void }) {
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description ?? "");
  // A change from GitHub or a teammate arrives through the query; adopt it
  // unless this user is mid-edit.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setTitle(issue.title);
    setDescription(issue.description ?? "");
  }, [issue.title, issue.description, dirty]);

  const save = useMutation({
    mutationFn: () => updateIssue(issue.id, { title: title.trim(), description: description.trim() || null }),
    onSuccess: (next) => {
      onSaved({ title: next.title, description: next.description });
      setDirty(false);
    },
  });

  return (
    <div className="bg-surface border-border-subtle flex flex-col gap-4 rounded-lg border p-5 shadow-[var(--shadow-e100)]">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="issue-title" className="text-text-subtlest text-xs font-bold tracking-wide uppercase">
          Title
        </label>
        <Input
          id="issue-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
          className="bg-surface h-10 text-base font-semibold"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="issue-description" className="text-text-subtlest text-xs font-bold tracking-wide uppercase">
          Description
        </label>
        <Textarea
          id="issue-description"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setDirty(true);
          }}
          rows={8}
          placeholder="What needs to happen, and how will we know it is done?"
          className="bg-surface text-sm"
        />
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!dirty || !title.trim() || save.isPending}
          onClick={() => save.mutate()}
          className="bg-brand hover:bg-brand-hover h-8 text-xs font-semibold text-white"
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
        {dirty && <span className="text-text-subtlest text-xs">Unsaved changes</span>}
        {save.isError && <span className="text-destructive text-xs">{save.error.message}</span>}
      </div>
    </div>
  );
}

function PrioritySelect({ issue, onSaved }: { issue: IssueDetail; onSaved: (patch: Partial<IssueDetail>) => void }) {
  const save = useMutation({
    mutationFn: (priority: Priority | null) => updateIssue(issue.id, { priority }),
    onSuccess: (next) => onSaved({ priority: next.priority }),
  });

  return (
    <Section title="Priority">
      <div className="flex flex-wrap gap-1.5">
        {PRIORITIES.map((p) => (
          <button
            key={p}
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate(issue.priority === p ? null : p)}
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              issue.priority === p
                ? "bg-brand-subtle text-brand"
                : "bg-surface-subtle text-text-subtle hover:bg-surface-hover",
            )}
          >
            <span className={cn("mr-1 font-bold", PRIORITY_MARK[p].className)}>{PRIORITY_MARK[p].glyph}</span>
            {PRIORITY_MARK[p].label}
          </button>
        ))}
      </div>
    </Section>
  );
}

function Assignees({ issue, onSaved }: { issue: IssueDetail; onSaved: (patch: Partial<IssueDetail>) => void }) {
  const { data: members } = useQuery({
    queryKey: ["members", issue.organizationId],
    queryFn: () => getMembers(issue.organizationId),
  });
  const [picking, setPicking] = useState(false);

  const add = useMutation({
    mutationFn: (userId: string) => addAssignee(issue.id, userId),
    onSuccess: (next) => {
      onSaved({ assignees: next.assignees });
      setPicking(false);
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => removeAssignee(issue.id, userId),
    onSuccess: (next) => onSaved({ assignees: next.assignees }),
  });

  const unassigned = (members ?? []).filter((m) => !issue.assignees.some((a) => a.id === m.id));

  return (
    <Section title="Assignees">
      <div className="flex flex-col gap-1.5">
        {issue.assignees.map((user) => (
          <span key={user.id} className="bg-surface-subtle flex items-center gap-2 rounded-md px-2 py-1.5">
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                avatarTint(user.id),
              )}
            >
              {initials(user.email)}
            </span>
            <span className="text-text-strong truncate text-xs">{user.email}</span>
            <button
              type="button"
              onClick={() => remove.mutate(user.id)}
              aria-label={`Unassign ${user.email}`}
              className="text-text-subtlest hover:text-destructive ml-auto"
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        {issue.assignees.length === 0 && <p className="text-text-subtlest text-xs">Nobody yet.</p>}

        {picking ? (
          <div className="border-border-subtle flex max-h-48 flex-col overflow-y-auto rounded-md border">
            {unassigned.length === 0 && <p className="text-text-subtlest p-2 text-xs">Everyone is already assigned.</p>}
            {unassigned.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => add.mutate(m.id)}
                className="hover:bg-surface-hover px-2 py-1.5 text-left text-xs"
              >
                {m.email}
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="text-text-subtle hover:bg-surface-hover flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium"
          >
            <Plus className="size-3.5" /> Assign someone
          </button>
        )}
        {(add.isError || remove.isError) && (
          <p className="text-destructive text-xs">{(add.error ?? remove.error)?.message}</p>
        )}
      </div>
    </Section>
  );
}

function Labels({
  issue,
  boardId,
  onSaved,
}: {
  issue: IssueDetail;
  boardId: string;
  onSaved: (patch: Partial<IssueDetail>) => void;
}) {
  const queryClient = useQueryClient();
  const labelsKey = ["labels", boardId] as const;
  const { data: labels } = useQuery({ queryKey: labelsKey, queryFn: () => getLabels(boardId) });
  const [name, setName] = useState("");

  const attach = useMutation({
    mutationFn: (labelId: string) => addLabel(issue.id, labelId),
    onSuccess: (next) => onSaved({ labels: next.labels }),
  });
  const detach = useMutation({
    mutationFn: (labelId: string) => removeLabel(issue.id, labelId),
    onSuccess: (next) => onSaved({ labels: next.labels }),
  });
  const create = useMutation({
    mutationFn: () => createLabel(boardId, { name: name.trim() }),
    onSuccess: async (label) => {
      await queryClient.invalidateQueries({ queryKey: labelsKey });
      setName("");
      attach.mutate(label.id);
    },
  });

  const available = (labels ?? []).filter((l) => !issue.labels.some((x) => x.id === l.id));

  return (
    <Section title="Labels">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((label) => (
            <span
              key={label.id}
              className={cn("flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold", labelClass(label.color))}
            >
              {label.name}
              <button type="button" onClick={() => detach.mutate(label.id)} aria-label={`Remove ${label.name}`}>
                <X className="size-3" />
              </button>
            </span>
          ))}
          {issue.labels.length === 0 && <p className="text-text-subtlest text-xs">No labels.</p>}
        </div>

        {available.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {available.map((label) => (
              <button
                key={label.id}
                type="button"
                onClick={() => attach.mutate(label.id)}
                className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold opacity-60 hover:opacity-100", labelClass(label.color))}
              >
                + {label.name}
              </button>
            ))}
          </div>
        )}

        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New label"
            className="bg-surface h-7 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || create.isPending} className="h-7 text-xs">
            Add
          </Button>
        </form>
      </div>
    </Section>
  );
}

function Links({ issue, boardId }: { issue: IssueDetail; boardId: string }) {
  const { data: integrations } = useQuery({ queryKey: ["integrations", boardId], queryFn: () => getIntegrations(boardId) });
  const slack = integrations?.find((i) => i.provider === "SLACK");

  return (
    <Section title="Elsewhere">
      <div className="flex flex-col gap-1.5 text-xs">
        {issue.githubUrl ? (
          <a
            href={issue.githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-text-subtle hover:bg-surface-hover flex items-center gap-1.5 rounded-md px-2 py-1.5"
          >
            <ExternalLink className="size-3.5" />
            GitHub issue #{issue.githubNumber}
          </a>
        ) : (
          <p className="text-text-subtlest px-2">
            {issue.repository ? "Not mirrored to GitHub." : "No repository linked to this board."}
          </p>
        )}

        {slack?.connected ? (
          <p className="text-text-subtle flex items-center gap-1.5 px-2 py-1.5">
            <Hash className="size-3.5" />
            Updates go to {slack.label ?? "Slack"}
          </p>
        ) : (
          <p className="text-text-subtlest px-2">No Slack channel connected.</p>
        )}

        <Link
          to="/boards/$boardId/settings"
          params={{ boardId }}
          className="text-text-subtle hover:bg-surface-hover rounded-md px-2 py-1.5 underline"
        >
          Board integrations
        </Link>
      </div>
    </Section>
  );
}

function Comments({ issue, onAdded }: { issue: IssueDetail; onAdded: (comment: IssueDetail["comments"][number]) => void }) {
  const [content, setContent] = useState("");
  const post = useMutation({
    mutationFn: () => addComment(issue.id, content.trim()),
    onSuccess: (comment) => {
      onAdded(comment);
      setContent("");
    },
  });

  return (
    <div className="bg-surface border-border-subtle flex flex-col gap-3 rounded-lg border p-5 shadow-[var(--shadow-e100)]">
      <h2 className="text-text-subtlest text-xs font-bold tracking-wide uppercase">
        Comments {issue.comments.length > 0 && `(${issue.comments.length})`}
      </h2>

      {issue.comments.map((comment) => (
        <article key={comment.id} className="flex gap-2.5">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white",
              avatarTint(comment.user.id),
            )}
          >
            {initials(comment.user.email)}
          </span>
          <div className="min-w-0">
            <p className="text-text-subtlest text-xs">
              {comment.user.email} · {new Date(comment.createdAt).toLocaleString()}
            </p>
            <p className="text-text-strong text-sm whitespace-pre-wrap">{comment.content}</p>
          </div>
        </article>
      ))}
      {issue.comments.length === 0 && <p className="text-text-subtlest text-sm">No comments yet.</p>}

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (content.trim()) post.mutate();
        }}
      >
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          placeholder="Add a comment"
          className="bg-surface text-sm"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!content.trim() || post.isPending}
          className="bg-brand hover:bg-brand-hover h-8 self-start text-xs font-semibold text-white"
        >
          {post.isPending ? "Posting…" : "Comment"}
        </Button>
        {post.isError && <p className="text-destructive text-xs">{post.error.message}</p>}
      </form>
    </div>
  );
}

function DangerZone({ issue, onDeleted }: { issue: IssueDetail; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({ mutationFn: () => deleteIssue(issue.id), onSuccess: onDeleted });

  return (
    <Section title="Danger zone">
      {confirming ? (
        <div className="flex flex-col gap-2">
          <p className="text-text-subtle text-xs">Delete {issue.key} permanently?</p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
              className="text-destructive h-7 text-xs"
            >
              {remove.isPending ? "Deleting…" : "Yes, delete"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} className="h-7 text-xs">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-text-subtle hover:text-destructive flex items-center gap-1.5 px-2 py-1 text-xs"
        >
          <Trash2 className="size-3.5" /> Delete this issue
        </button>
      )}
      {remove.isError && <p className="text-destructive text-xs">{remove.error.message}</p>}
    </Section>
  );
}
