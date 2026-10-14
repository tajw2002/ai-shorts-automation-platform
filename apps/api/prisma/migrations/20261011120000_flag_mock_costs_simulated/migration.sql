-- Mock adapters cost nothing, but outside DRY_RUN their calls were recorded as
-- real spend (simulated = false). With pictures mocked while text and voice were
-- live, those bookings filled the daily budget and paused generation.
-- Data only; safe to re-run.

UPDATE "CostRecord"
SET "simulated" = true
WHERE "provider" = 'mock' AND "simulated" = false;

-- The per-video roll-up shows money spent: rebuild it from real rows only, taking
-- the actual cost where a provider reported one and the estimate otherwise.
UPDATE "Video" AS v
SET "costMicros" = COALESCE(
  (
    SELECT SUM(COALESCE(c."actualMicros", c."estimatedMicros"))
    FROM "CostRecord" AS c
    WHERE c."videoId" = v."id" AND c."simulated" = false
  ),
  0
);
