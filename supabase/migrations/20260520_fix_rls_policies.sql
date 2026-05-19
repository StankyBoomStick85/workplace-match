-- Idempotent: create RLS policies for match_scores and saved_jobs if not already present.
-- Run this if the original migration ran but policies were skipped (e.g. tables pre-existed).

DO $$ BEGIN
  CREATE POLICY "candidates read own scores"
    ON public.match_scores FOR SELECT
    USING (auth.uid() = candidate_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "service role manages scores"
    ON public.match_scores FOR ALL TO service_role
    USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "candidates manage own saved jobs"
    ON public.saved_jobs FOR ALL
    USING (auth.uid() = candidate_id)
    WITH CHECK (auth.uid() = candidate_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
