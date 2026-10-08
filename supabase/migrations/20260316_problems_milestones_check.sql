-- The live database enforces milestones BETWEEN 2 AND 5 on problems
-- (error: new row for relation "problems" violates check constraint
-- "problems_milestones_check"), but no migration in this repo created it.
-- This migration backfills the constraint for fresh environments and
-- clamps any legacy rows, and is a no-op where it already exists.
UPDATE problems SET milestones = 3 WHERE milestones IS NULL OR milestones < 2 OR milestones > 5;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'problems_milestones_check'
  ) THEN
    ALTER TABLE problems
      ADD CONSTRAINT problems_milestones_check CHECK (milestones >= 2 AND milestones <= 5);
  END IF;
END
$$;
