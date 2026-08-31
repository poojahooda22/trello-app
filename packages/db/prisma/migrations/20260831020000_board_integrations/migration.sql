-- Phase 1: per-board integrations. `config` holds the provider secret
-- encrypted at rest (AES-256-GCM, see apps/backend/secrets.ts).

CREATE TYPE "IntegrationProvider" AS ENUM ('SLACK', 'GITHUB');

CREATE TABLE "BoardIntegration" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "config" TEXT NOT NULL,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastEventAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BoardIntegration_boardId_provider_key" ON "BoardIntegration"("boardId", "provider");

ALTER TABLE "BoardIntegration" ADD CONSTRAINT "BoardIntegration_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE ON UPDATE CASCADE;
