-- Track which scoring mode (quick / gig / career) produced each match score.
-- Previously match_scores had UNIQUE(candidate_id, job_id) only, so quick/gig/career
-- scores for the same job overwrote each other and whichever mode scored last "won".
ALTER TABLE public.match_scores
  ADD COLUMN scoring_mode text NOT NULL DEFAULT 'career' CHECK (scoring_mode IN ('quick', 'gig', 'career'));

-- Existing rows predate this column and are of unknown mode. Expire them (do not
-- delete) so the next scoring poll naturally repopulates correct per-mode rows.
UPDATE public.match_scores SET expires_at = now();

-- NOTE: match_scores_candidate_id_job_id_key is the default Postgres-assigned name
-- for the unnamed UNIQUE(candidate_id, job_id) constraint from the original
-- CREATE TABLE in 20260519_create_match_scores.sql. If this migration fails with
-- "constraint does not exist", check the live constraint name in the Supabase
-- dashboard and adjust this statement before re-running.
ALTER TABLE public.match_scores DROP CONSTRAINT match_scores_candidate_id_job_id_key;
ALTER TABLE public.match_scores ADD CONSTRAINT match_scores_candidate_id_job_id_scoring_mode_key UNIQUE (candidate_id, job_id, scoring_mode);

CREATE INDEX ON public.match_scores(candidate_id, scoring_mode);
