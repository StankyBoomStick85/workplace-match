-- Career Move gap analysis: for a single job a candidate expands, explains what
-- specifically separates them from a stronger match. Generated on demand (not during
-- batch scoring) and cached here so re-expanding the same row doesn't re-run the model.
--
-- Deliberately NOT stored in match_scores: that table is hard-deleted on every
-- forceRescore and expires every 6 hours for external (adzuna) jobs, since the
-- match *score* genuinely needs to stay fresh. A gap analysis is much more stable
-- (it only depends on the job's own requirements and the candidate's capability
-- profile, not on a scoring-mode refresh cycle) and would be silently destroyed by
-- match_scores' churn if it lived there.
CREATE TABLE IF NOT EXISTS public.job_gap_analysis (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id       text        NOT NULL,
  job_source   text        NOT NULL CHECK (job_source IN ('wpm', 'adzuna')),
  gap_data     jsonb       NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  -- Captured at the moment the candidate's profile was read to generate this
  -- analysis. candidate_profiles has no updated_at/created_at column of its own
  -- (confirmed: no such column exists in this database), so there is no true
  -- "profile last changed" timestamp to compare against yet. This column is not
  -- used for invalidation now - it exists so a future staleness check (e.g. "the
  -- candidate corrected their capability profile after this analysis was
  -- generated") can be added without a further migration, once candidate_profiles
  -- itself gains a real last-modified timestamp.
  generated_against_profile_at timestamptz NOT NULL,
  UNIQUE(candidate_id, job_id)
);

CREATE INDEX ON public.job_gap_analysis(candidate_id);

ALTER TABLE public.job_gap_analysis ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages job gap analysis"
  ON public.job_gap_analysis FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Matches the pattern found on access_requests/approved_emails/users where a table
-- created outside Supabase's own migration tooling did not automatically receive
-- service_role grants - see prior incident where /request-access failed with
-- "permission denied for table access_requests" (42501) despite RLS being correct.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_gap_analysis TO service_role;
