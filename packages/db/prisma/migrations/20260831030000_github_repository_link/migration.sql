-- Phase 2: bind a GitHub repository to a board, and link cards to GitHub issues.

-- config holds an encrypted secret for Slack; GitHub has none to store.
ALTER TABLE "BoardIntegration" ALTER COLUMN "config" DROP NOT NULL;

-- externalId is the public, queryable identifier ("owner/repo"): an incoming
-- webhook resolves its board from it, so cards are never matched globally.
ALTER TABLE "BoardIntegration" ADD COLUMN "externalId" TEXT,
ADD COLUMN "installationId" INTEGER,
ADD COLUMN "mirrorIssues" BOOLEAN NOT NULL DEFAULT false;

-- NULLs are distinct in a Postgres unique index, so Slack rows are unaffected.
CREATE UNIQUE INDEX "BoardIntegration_provider_externalId_key" ON "BoardIntegration"("provider", "externalId");

ALTER TABLE "Issue" ADD COLUMN "githubNumber" INTEGER;
CREATE UNIQUE INDEX "Issue_boardId_githubNumber_key" ON "Issue"("boardId", "githubNumber");
