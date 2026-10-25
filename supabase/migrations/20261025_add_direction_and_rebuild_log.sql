-- Profile control, slice 1: the candidate's direction ("Where I'm heading")
-- and the log behind candidate-triggered rebuild limits and the follow-up queue.
--
-- direction (jsonb), written only by /api/applicant/direction:
--   { "roleFamilies": ["operations_leadership", ...],   -- ids from lib/roleFamilies.ts, plus "other"
--     "otherFamily": "...",                              -- only with "other"
--     "scope": "open_related" | "only_these",
--     "titles": ["..."],                                 -- only when scope = only_these
--     "workSetting": "remote" | "hybrid" | "onsite" | "open",
--     "howIWantToWork": "..." }                           -- <= 160 chars
-- job_types and work_preference stay, written from direction for older readers.

ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS direction jsonb;

-- One row per rebuild request (lib/profileRebuilds.ts).
--   status: started    - a capability statement job was created (counts toward the daily limit)
--           queued     - waiting behind the candidate's running job (at most one per candidate)
--           dequeued   - a queued request that has since been started
--           superseded - a queued request folded into a later one
--           limited    - refused: daily limit reached
--           skipped    - could not start (e.g. no statements to write a summary from)
CREATE TABLE IF NOT EXISTS public.profile_rebuild_log (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('summary', 'full')),
  status text NOT NULL CHECK (status IN ('started', 'queued', 'dequeued', 'superseded', 'limited', 'skipped')),
  source text NOT NULL,
  job_id uuid,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profile_rebuild_log_user_created_idx
  ON public.profile_rebuild_log (user_id, created_at);
CREATE INDEX IF NOT EXISTS profile_rebuild_log_user_status_idx
  ON public.profile_rebuild_log (user_id, status);

-- Server-only: written and read with the service role (which bypasses RLS).
-- RLS on with no policies, so anon and authenticated clients get nothing.
ALTER TABLE public.profile_rebuild_log ENABLE ROW LEVEL SECURITY;
