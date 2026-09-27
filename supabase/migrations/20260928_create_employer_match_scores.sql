-- Employer-direction AI match scores: "how well does this candidate fit this
-- job", the mirror of match_scores' "how well does this job fit this
-- candidate". Deliberately a separate table, not a new match_scores.scoring_mode
-- value:
--   1. match_scores RLS is `USING (auth.uid() = candidate_id)` - it exists to
--      let a candidate read their own scores. An employer reading rows here
--      needs the opposite ownership check; bolting that onto a table whose
--      whole contract is "the candidate owns this row" is the wrong place for
--      it. This table gets its own policy scoped to employer_id instead.
--   2. quick/gig/career are candidate-perspective lenses on the same question.
--      Direction (candidate->job vs employer->candidate) is a different
--      question asked by a different party, not another lens - conflating the
--      two into one enum invites a future query that mixes rows meant for two
--      different audiences.
--   3. Employer-direction scoring only ever applies to this employer's own WPM
--      postings - there is no external-candidate concept the way match_scores
--      has external (adzuna) jobs, so this table doesn't need a job_source split.
--
-- Cache invalidation: neither candidate_profiles nor job_posts has an
-- updated_at column (confirmed - see the same note already left in
-- job_gap_analysis's migration). candidate_content_hash / job_content_hash are
-- SHA-256 over exactly the fields sent to the scoring prompt; the scoring route
-- recomputes both fresh on every request and only calls the model when either
-- hash no longer matches what's stored, instead of relying on a timestamp that
-- doesn't exist yet.
CREATE TABLE IF NOT EXISTS public.employer_match_scores (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  candidate_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id                 uuid        NOT NULL REFERENCES public.job_posts(id) ON DELETE CASCADE,
  score                  integer     NOT NULL CHECK (score >= 0 AND score <= 100),
  candidate_content_hash text        NOT NULL,
  job_content_hash       text        NOT NULL,
  scored_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE(employer_id, candidate_id, job_id)
);

CREATE INDEX ON public.employer_match_scores(employer_id, job_id);
CREATE INDEX ON public.employer_match_scores(candidate_id);

ALTER TABLE public.employer_match_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employers read own scored candidates"
  ON public.employer_match_scores FOR SELECT
  USING (auth.uid() = employer_id);

CREATE POLICY "service role manages employer match scores"
  ON public.employer_match_scores FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Matches the pattern found on access_requests/approved_emails/job_gap_analysis
-- where a table created outside Supabase's own migration tooling did not
-- automatically receive service_role grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employer_match_scores TO service_role;
