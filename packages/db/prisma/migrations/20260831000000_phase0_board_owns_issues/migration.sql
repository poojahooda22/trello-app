-- Phase 0: the board owns its issues. Columns get a kind, boards get a key
-- prefix and a per-board issue counter, issues get boardId + number.

-- CreateEnum
CREATE TYPE "SectionKind" AS ENUM ('BACKLOG', 'TODO', 'INPROGRESS', 'REVIEW', 'DONE');

-- Board: key prefix + counter
ALTER TABLE "Board" ADD COLUMN     "issueCounter" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "keyPrefix" TEXT NOT NULL DEFAULT 'BRD';

-- Existing boards: derive the prefix from the title, same rule as keyPrefixFor()
-- in apps/backend/board-rules.ts ("Zepto Board" -> ZEP).
UPDATE "Board" SET "keyPrefix" = CASE
  WHEN length(regexp_replace(title, '[^A-Za-z0-9]', '', 'g')) >= 2
    THEN upper(substr(regexp_replace(title, '[^A-Za-z0-9]', '', 'g'), 1, 3))
  ELSE 'BRD'
END;

-- Section: kind (null for custom columns), unique per board
ALTER TABLE "Section" ADD COLUMN     "kind" "SectionKind";
CREATE UNIQUE INDEX "Section_boardId_kind_key" ON "Section"("boardId", "kind");

-- Issue: boardId + number. Added nullable, backfilled from the section and the
-- existing order, then made NOT NULL so the migration also works on a database
-- that already has cards.
ALTER TABLE "Issue" ADD COLUMN     "boardId" TEXT,
ADD COLUMN     "number" INTEGER;

UPDATE "Issue" i SET "boardId" = s."boardId"
FROM "Section" s
WHERE i."sectionId" = s.id;

UPDATE "Issue" i SET "number" = numbered.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY "boardId" ORDER BY "position", id) AS rn
  FROM "Issue"
) numbered
WHERE i.id = numbered.id;

UPDATE "Board" b SET "issueCounter" = COALESCE((SELECT max("number") FROM "Issue" WHERE "boardId" = b.id), 0);

ALTER TABLE "Issue" ALTER COLUMN "boardId" SET NOT NULL,
ALTER COLUMN "number" SET NOT NULL;

CREATE UNIQUE INDEX "Issue_boardId_number_key" ON "Issue"("boardId", "number");

ALTER TABLE "Issue" ADD CONSTRAINT "Issue_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE ON UPDATE CASCADE;
