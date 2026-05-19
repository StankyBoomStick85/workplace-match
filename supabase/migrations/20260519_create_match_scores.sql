CREATE TABLE IF NOT EXISTS public.match_scores (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id       text        NOT NULL,
  job_source   text        NOT NULL CHECK (job_source IN ('wpm', 'adzuna')),
  score        integer     NOT NULL CHECK (score >= 0 AND score <= 100),
  scored_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  UNIQUE(candidate_id, job_id)
);

CREATE INDEX ON public.match_scores(candidate_id);
CREATE INDEX ON public.match_scores(job_id);

ALTER TABLE public.match_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "candidates read own scores"
  ON public.match_scores FOR SELECT
  USING (auth.uid() = candidate_id);

CREATE POLICY "service role manages scores"
  ON public.match_scores FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- saved_jobs: candidates can save external and WPM job listings
CREATE TABLE IF NOT EXISTS public.saved_jobs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id       text        NOT NULL,
  job_source   text        NOT NULL CHECK (job_source IN ('wpm', 'adzuna')),
  job_title    text,
  company      text,
  location     text,
  salary_min   numeric,
  salary_max   numeric,
  url          text,
  saved_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE(candidate_id, job_id)
);

CREATE INDEX ON public.saved_jobs(candidate_id);

ALTER TABLE public.saved_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "candidates manage own saved jobs"
  ON public.saved_jobs FOR ALL
  USING (auth.uid() = candidate_id)
  WITH CHECK (auth.uid() = candidate_id);
