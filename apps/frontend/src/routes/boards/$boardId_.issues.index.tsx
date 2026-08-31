/** src/routes/boards/$boardId_.issues.index.tsx -> "/boards/$boardId/issues" — every issue on the board in one list. */
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, GitPullRequest, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { AppNavbar } from "@/components/app/app-navbar";
import { AppSidebar } from "@/components/app/app-sidebar";
import { Input } from "@/components/ui/input";
import { getIntegrations, getPullRequests, getSections, type Issue, type Section } from "@/lib/api";
import { PRIORITY_MARK, avatarTint, initials, labelClass } from "@/lib/issue-style";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/boards/$boardId_/issues/")({
  component: IssuesList,
});

function IssuesList() {
  const { boardId } = Route.useParams();
  const [query, setQuery] = useState("");
  const [column, setColumn] = useState<string>("ALL");

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["sections", boardId],
    queryFn: () => getSections(boardId),
  });
  const { data: integrations } = useQuery({
    queryKey: ["integrations", boardId],
    queryFn: () => getIntegrations(boardId),
  });
  const github = integrations?.find((i) => i.provider === "GITHUB");

  // Open pull requests, matched to cards by the key in their branch name — the
  // "which PR is this issue in?" question, answered without leaving the board.
  const { data: prs } = useQuery({
    queryKey: ["pulls", boardId],
    queryFn: () => getPullRequests(boardId),
    enabled: Boolean(github?.connected),
    retry: false,
  });

  const sections: Section[] = data?.sections ?? [];
  const rows = useMemo(() => {
    const all = sections.flatMap((s) => s.issues.map((issue) => ({ issue, section: s })));
    const needle = query.trim().toLowerCase();
    return all.filter(
      ({ issue, section }) =>
        (column === "ALL" || section.id === column) &&
        (needle === "" ||
          issue.title.toLowerCase().includes(needle) ||
          issue.key.toLowerCase().includes(needle) ||
          issue.labels.some((l) => l.name.toLowerCase().includes(needle)) ||
          issue.assignees.some((a) => a.email.toLowerCase().includes(needle))),
    );
  }, [sections, query, column]);

  const prFor = (issue: Issue) =>
    (prs?.pulls ?? []).find((p) => `${p.branch} ${p.title}`.toUpperCase().includes(issue.key.toUpperCase()));

  return (
    <div className="bg-surface-sunken flex min-h-dvh flex-col">
      <AppNavbar />

      <div className="flex min-h-0 flex-1">
        <AppSidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="border-border-subtle bg-surface flex shrink-0 flex-wrap items-center gap-3 border-b px-6 py-3">
            <Link
              to="/boards/$boardId"
              params={{ boardId }}
              className="text-text-subtle hover:bg-surface-hover flex size-8 items-center justify-center rounded-md transition-colors"
              aria-label="Back to board"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div className="min-w-0">
              <h1 className="text-text-strong truncate text-lg font-semibold">Issues</h1>
              <p className="text-text-subtlest truncate text-xs">
                {rows.length} of {sections.reduce((n, s) => n + s.issues.length, 0)}
                {github?.externalId ? ` · ${github.externalId}` : ""}
              </p>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Search className="text-text-subtlest pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by title, key, label or assignee"
                  aria-label="Filter issues"
                  className="bg-surface-sunken h-9 w-72 pl-8 text-sm"
                />
              </div>
              <select
                value={column}
                onChange={(e) => setColumn(e.target.value)}
                aria-label="Filter by column"
                className="border-border-subtle bg-surface text-text-subtle h-9 rounded-md border px-2 text-sm"
              >
                <option value="ALL">All columns</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
          </header>

          {isPending && <p className="text-text-subtlest p-6 text-sm">Loading…</p>}
          {isError && <p className="text-destructive p-6 text-sm">{error.message}</p>}

          {data && (
            <div className="mx-auto w-full max-w-6xl px-6 py-6">
              {rows.length === 0 ? (
                <p className="text-text-subtlest text-sm">No issues match.</p>
              ) : (
                <ul className="border-border-subtle bg-surface divide-border-subtle divide-y overflow-hidden rounded-lg border shadow-[var(--shadow-e100)]">
                  {rows.map(({ issue, section }) => {
                    const pr = prFor(issue);
                    return (
                      <li key={issue.id}>
                        <Link
                          to="/boards/$boardId/issues/$issueId"
                          params={{ boardId, issueId: issue.id }}
                          className="hover:bg-surface-hover flex items-center gap-3 px-4 py-2.5 transition-colors"
                        >
                          <span className="text-text-subtle w-20 shrink-0 text-xs font-medium">{issue.key}</span>

                          {issue.priority && (
                            <span
                              className={cn("w-5 shrink-0 text-xs font-bold", PRIORITY_MARK[issue.priority].className)}
                              title={`${PRIORITY_MARK[issue.priority].label} priority`}
                            >
                              {PRIORITY_MARK[issue.priority].glyph}
                            </span>
                          )}

                          <span className="text-text-strong min-w-0 flex-1 truncate text-sm">{issue.title}</span>

                          <span className="hidden shrink-0 gap-1 md:flex">
                            {issue.labels.slice(0, 2).map((l) => (
                              <span
                                key={l.id}
                                className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold", labelClass(l.color))}
                              >
                                {l.name}
                              </span>
                            ))}
                          </span>

                          {pr && (
                            <span
                              className="text-text-subtle hidden shrink-0 items-center gap-1 text-xs lg:flex"
                              title={`${pr.title} (${pr.branch})`}
                            >
                              <GitPullRequest className="size-3.5" />#{pr.number}
                            </span>
                          )}
                          {!pr && issue.githubNumber !== null && (
                            <span className="text-text-subtlest hidden shrink-0 items-center gap-1 text-xs lg:flex">
                              <ExternalLink className="size-3" />#{issue.githubNumber}
                            </span>
                          )}

                          <span className="text-text-subtlest w-28 shrink-0 truncate text-right text-xs">
                            {section.title}
                          </span>

                          <span className="flex w-14 shrink-0 justify-end -space-x-1">
                            {issue.assignees.slice(0, 2).map((u) => (
                              <span
                                key={u.id}
                                title={u.email}
                                className={cn(
                                  "border-surface flex size-5 items-center justify-center rounded-full border text-[9px] font-bold text-white",
                                  avatarTint(u.id),
                                )}
                              >
                                {initials(u.email)}
                              </span>
                            ))}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
