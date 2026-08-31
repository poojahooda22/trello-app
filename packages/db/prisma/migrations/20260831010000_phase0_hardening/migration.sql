-- Phase 0 hardening: issue versioning for event ordering, digit-safe key
-- prefixes, and per-organization prefix uniqueness (enforced by the database).

ALTER TABLE "Issue" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- Recompute prefixes with the digit-safe rule (leading digits stripped so the
-- key parser, which requires a letter first, can read them). Mirrors
-- keyPrefixFor() in apps/backend/board-rules.ts.
UPDATE "Board" SET "keyPrefix" = CASE
  WHEN length(regexp_replace(regexp_replace(title, '[^A-Za-z0-9]', '', 'g'), '^[0-9]+', '')) >= 2
    THEN upper(substr(regexp_replace(regexp_replace(title, '[^A-Za-z0-9]', '', 'g'), '^[0-9]+', ''), 1, 3))
  ELSE 'BRD'
END;

-- Suffix duplicates within an organization (ZEP, ZEP2, ZEP3…), processing in a
-- stable order so each row only has to avoid the rows finalized before it.
DO $$
DECLARE
  b RECORD;
  base TEXT;
  candidate TEXT;
  n INT;
BEGIN
  FOR b IN SELECT id, "organizationId", "keyPrefix" FROM "Board" ORDER BY id LOOP
    base := b."keyPrefix";
    candidate := base;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM "Board"
      WHERE "organizationId" = b."organizationId" AND "keyPrefix" = candidate AND id < b.id
    ) LOOP
      n := n + 1;
      candidate := base || n::text;
    END LOOP;
    IF candidate <> b."keyPrefix" THEN
      UPDATE "Board" SET "keyPrefix" = candidate WHERE id = b.id;
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX "Board_organizationId_keyPrefix_key" ON "Board"("organizationId", "keyPrefix");
