/** src/routes/boards/$boardId_.settings.tsx -> "/boards/$boardId/settings" (its own page, not nested in the board) */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Check, GitPullRequest, Hash, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { AppNavbar } from "@/components/app/app-navbar";
import { AppSidebar } from "@/components/app/app-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  connectGitHub,
  connectSlack,
  disconnectIntegration,
  getBoards,
  getIntegrations,
  getOrganizations,
  setIntegrationEnabled,
  setMirrorIssues,
  testSlack,
  type IntegrationStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/boards/$boardId_/settings")({
  component: BoardSettings,
});

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

function BoardSettings() {
  const { boardId } = Route.useParams();
  const queryClient = useQueryClient();
  const key = ["integrations", boardId] as const;

  const { data: integrations, isPending, isError, error } = useQuery({
    queryKey: key,
    queryFn: () => getIntegrations(boardId),
  });

  const { data: organizations } = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations, retry: false });
  const boardQueries = useQueries({
    queries: (organizations ?? []).map((org) => ({ queryKey: ["boards", org.id], queryFn: () => getBoards(org.id) })),
  });
  const board = boardQueries.flatMap((q) => q.data ?? []).find((b) => b.id === boardId);

  const slack = integrations?.find((i) => i.provider === "SLACK");
  const github = integrations?.find((i) => i.provider === "GITHUB");

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
              <h1 className="text-text-strong truncate text-lg font-semibold">{board?.title ?? "Board"} settings</h1>
              <p className="text-text-subtlest truncate text-xs">Integrations</p>
            </div>
          </header>

          <div className="mx-auto w-full max-w-2xl px-6 py-8">
            {isPending && <p className="text-text-subtlest text-sm">Loading…</p>}
            {isError && <p className="text-destructive text-sm">{error.message}</p>}

            {integrations && (
              <div className="flex flex-col gap-4">
                <SlackCard
                  boardId={boardId}
                  status={slack}
                  onChanged={async (next) => {
                    // Cancel first: an in-flight refetch would otherwise land
                    // after this write and restore the pre-change state.
                    await queryClient.cancelQueries({ queryKey: key });
                    queryClient.setQueryData(key, next);
                  }}
                />
                <GitHubCard
                  boardId={boardId}
                  status={github}
                  onChanged={async (next) => {
                    await queryClient.cancelQueries({ queryKey: key });
                    queryClient.setQueryData(key, next);
                  }}
                />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function CardShell({
  icon,
  title,
  description,
  status,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status?: IntegrationStatus;
  children: React.ReactNode;
}) {
  const connected = status?.connected ?? false;
  const failing = Boolean(status?.lastError);

  return (
    <section className="bg-surface border-border-subtle rounded-lg border p-5 shadow-[var(--shadow-e100)]">
      <div className="flex items-start gap-3">
        <span className="bg-surface-subtle text-text-strong flex size-9 shrink-0 items-center justify-center rounded-md">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-text-strong font-semibold">{title}</h2>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase",
                connected && !failing && "bg-brand-subtle text-brand",
                connected && failing && "bg-destructive/10 text-destructive",
                !connected && "bg-surface-subtle text-text-subtlest",
              )}
            >
              {connected ? (failing ? "Failing" : status?.enabled ? "Connected" : "Paused") : "Not connected"}
            </span>
          </div>
          <p className="text-text-subtle pt-0.5 text-sm">{description}</p>
        </div>
      </div>
      <div className="pt-4">{children}</div>
    </section>
  );
}

function SlackCard({
  boardId,
  status,
  onChanged,
}: {
  boardId: string;
  status?: IntegrationStatus;
  onChanged: (next: IntegrationStatus[]) => void | Promise<void>;
}) {
  const [webhookUrl, setWebhookUrl] = useState("");
  const [label, setLabel] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  // One message for the whole card, cleared when any action starts — four
  // separate mutation.error fields would leave a stale failure on screen
  // after a later action succeeded.
  const [failure, setFailure] = useState<string | null>(null);
  const track = { onMutate: () => setFailure(null), onError: (e: Error) => setFailure(e.message) };

  const connect = useMutation({
    ...track,
    mutationFn: () => connectSlack(boardId, { webhookUrl: webhookUrl.trim(), label: label.trim() || undefined }),
    onSuccess: (next) => {
      void onChanged(next);
      setWebhookUrl("");
      setTestResult(null);
    },
  });

  const test = useMutation({
    ...track,
    mutationFn: () => testSlack(boardId),
    onSuccess: (result) => {
      void onChanged(result.integrations);
      setTestResult(result.ok ? "Sent — check the channel." : null);
      if (!result.ok) setFailure(result.error ?? "The message was not sent");
    },
  });

  const toggle = useMutation({
    ...track,
    mutationFn: (enabled: boolean) => setIntegrationEnabled(boardId, "SLACK", enabled),
    onSuccess: (next) => {
      void onChanged(next);
      setTestResult(null);
    },
  });

  const remove = useMutation({
    ...track,
    mutationFn: () => disconnectIntegration(boardId, "SLACK"),
    onSuccess: (next) => {
      void onChanged(next);
      setTestResult(null);
    },
  });

  const busy = connect.isPending || test.isPending || toggle.isPending || remove.isPending;

  return (
    <CardShell
      icon={<Hash className="size-5" />}
      title="Slack"
      description="Post a message to a channel when a card is created or moved on this board."
      status={status}
    >
      {status?.connected ? (
        <div className="flex flex-col gap-3">
          <dl className="text-text-subtle grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
            <dt className="text-text-subtlest">Channel</dt>
            <dd>{status.label ?? "—"}</dd>
            <dt className="text-text-subtlest">Webhook</dt>
            <dd className="font-mono text-xs">{status.hint ?? "unreadable"}</dd>
            <dt className="text-text-subtlest">Last delivery</dt>
            <dd>{relativeTime(status.lastEventAt) ?? "never"}</dd>
          </dl>

          {status.lastError && (
            <p className="text-destructive flex items-start gap-1.5 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span className="font-mono">{status.lastError}</span>
            </p>
          )}
          {testResult && !status.lastError && (
            <p className="text-brand flex items-center gap-1.5 text-xs">
              <Check className="size-3.5" />
              {testResult}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              // Nothing is sent while paused, so the button must not offer it.
              disabled={busy || !status.enabled}
              title={status.enabled ? undefined : "Resume the integration to send a test message"}
              onClick={() => test.mutate()}
              className="h-8 text-xs"
            >
              {test.isPending ? "Sending…" : "Send test message"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => toggle.mutate(!status.enabled)}
              className="h-8 text-xs"
            >
              {status.enabled ? "Pause" : "Resume"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => remove.mutate()}
              className="text-destructive hover:text-destructive h-8 text-xs"
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (webhookUrl.trim()) connect.mutate();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="slack-url" className="text-text-subtle text-xs font-medium">
              Incoming webhook URL
            </label>
            <Input
              id="slack-url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              className="bg-surface h-9 font-mono text-xs"
            />
            <p className="text-text-subtlest text-xs">
              Create one at{" "}
              <a
                href="https://api.slack.com/apps?new_app=1"
                target="_blank"
                rel="noreferrer noopener"
                className="underline"
              >
                api.slack.com/apps
              </a>{" "}
              → Incoming Webhooks → Add New Webhook to Workspace. Stored encrypted; never shown again.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="slack-label" className="text-text-subtle text-xs font-medium">
              Channel name (optional, for display)
            </label>
            <Input
              id="slack-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="#board-updates"
              className="bg-surface h-9 text-sm"
            />
          </div>

          <Button
            type="submit"
            size="sm"
            disabled={busy || !webhookUrl.trim()}
            className="bg-brand hover:bg-brand-hover h-8 self-start text-xs font-semibold text-white"
          >
            {connect.isPending ? "Connecting…" : "Connect Slack"}
          </Button>
        </form>
      )}

      {/* Live region: screen readers announce the outcome of an action. */}
      <p role="status" aria-live="polite" className="text-destructive pt-3 text-xs empty:pt-0">
        {failure}
      </p>
    </CardShell>
  );
}

function GitHubCard({
  boardId,
  status,
  onChanged,
}: {
  boardId: string;
  status?: IntegrationStatus;
  onChanged: (next: IntegrationStatus[]) => void | Promise<void>;
}) {
  const [repository, setRepository] = useState("");
  const [mirror, setMirror] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const track = { onMutate: () => setFailure(null), onError: (e: Error) => setFailure(e.message) };

  const connect = useMutation({
    ...track,
    mutationFn: (input: { repository: string; mirrorIssues: boolean }) => connectGitHub(boardId, input),
    onSuccess: (result) => {
      void onChanged(result.integrations);
      setWarning(result.warning);
      setRepository("");
    },
  });

  const toggle = useMutation({
    ...track,
    mutationFn: (enabled: boolean) => setIntegrationEnabled(boardId, "GITHUB", enabled),
    onSuccess,
  });

  // Its own endpoint: toggling the mirror must not re-bind the repository,
  // re-run installation discovery, or resume a deliberately paused link.
  const mirrorToggle = useMutation({
    ...track,
    mutationFn: (on: boolean) => setMirrorIssues(boardId, on),
    onSuccess,
  });

  const remove = useMutation({
    ...track,
    mutationFn: () => disconnectIntegration(boardId, "GITHUB"),
    onSuccess: (next) => {
      void onChanged(next);
      setWarning(null);
    },
  });

  function onSuccess(next: IntegrationStatus[]) {
    void onChanged(next);
  }

  const busy = connect.isPending || toggle.isPending || remove.isPending || mirrorToggle.isPending;

  return (
    <CardShell
      icon={<GitPullRequest className="size-5" />}
      title="GitHub"
      description="Issues opened in the repository become cards; opening a pull request moves its card to Review, and merging moves it to Done."
      status={status}
    >
      {status?.connected ? (
        <div className="flex flex-col gap-3">
          <dl className="text-text-subtle grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
            <dt className="text-text-subtlest">Repository</dt>
            <dd>
              <a
                href={`https://github.com/${status.externalId}`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono text-xs underline"
              >
                {status.externalId}
              </a>
            </dd>
            <dt className="text-text-subtlest">Mirror cards</dt>
            <dd>{status.mirrorIssues ? "On — new cards open a GitHub issue" : "Off — GitHub → board only"}</dd>
            <dt className="text-text-subtlest">Last event</dt>
            <dd>{relativeTime(status.lastEventAt) ?? "never"}</dd>
          </dl>

          {!status.canWrite && (
            <p className="text-text-subtlest flex items-start gap-1.5 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              The app can read events from this repository but cannot write to it — install the GitHub App on it and set
              GITHUB_APP_ID / GITHUB_PRIVATE_KEY on the server.
            </p>
          )}
          {status.lastError && (
            <p className="text-destructive flex items-start gap-1.5 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span className="font-mono">{status.lastError}</span>
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => mirrorToggle.mutate(!status.mirrorIssues)}
              className="h-8 text-xs"
            >
              {status.mirrorIssues ? "Stop mirroring cards" : "Mirror cards to GitHub"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => toggle.mutate(!status.enabled)}
              className="h-8 text-xs"
            >
              {status.enabled ? "Pause" : "Resume"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => remove.mutate()}
              className="text-destructive hover:text-destructive h-8 text-xs"
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (repository.trim()) connect.mutate({ repository: repository.trim(), mirrorIssues: mirror });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="gh-repo" className="text-text-subtle text-xs font-medium">
              Repository
            </label>
            <Input
              id="gh-repo"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              placeholder="owner/repository"
              className="bg-surface h-9 font-mono text-xs"
            />
            <p className="text-text-subtlest text-xs">
              The GitHub App must be installed on this repository, with its webhook pointing at this server. One
              repository can belong to only one board.
            </p>
          </div>

          <label className="text-text-subtle flex items-center gap-2 text-xs font-medium">
            <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} className="size-3.5" />
            Also create a GitHub issue when a card is added here
          </label>

          <Button
            type="submit"
            size="sm"
            disabled={busy || !repository.trim()}
            className="bg-brand hover:bg-brand-hover h-8 self-start text-xs font-semibold text-white"
          >
            {connect.isPending ? "Connecting…" : "Connect repository"}
          </Button>
        </form>
      )}

      {warning && <p className="text-text-subtlest pt-3 text-xs">{warning}</p>}
      <p role="status" aria-live="polite" className="text-destructive pt-3 text-xs empty:pt-0">
        {failure}
      </p>
    </CardShell>
  );
}
