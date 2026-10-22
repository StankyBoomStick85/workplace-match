-- Background jobs for Tier 1 capability statement synthesis.
--
-- A full synthesis on claude-fable-5-1 takes longer than one 300s function
-- invocation, so it runs as a chain of steps (one model call each). This row
-- holds the job's input snapshot and its resumable state between steps, and
-- the final result. Written and read only by the service role (admin routes
-- and the step worker); never exposed to candidates or employers.
--
-- status: running -> succeeded | failed
-- step_seq: the last step number claimed; a step runs only if it can claim
--   step_seq = previous + 1, so a duplicated trigger cannot run a step twice.
-- step_started_at: when the current step was claimed; a running job whose step
--   is older than the function limit is reported and marked failed on the next
--   status check.
CREATE TABLE IF NOT EXISTS public.capability_statement_jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL    DEFAULT now(),
  updated_at       timestamptz NOT NULL    DEFAULT now(),
  user_id          uuid        NOT NULL    REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_by     uuid                    REFERENCES auth.users(id) ON DELETE SET NULL,
  model            text        NOT NULL,
  dry_run          boolean     NOT NULL    DEFAULT true,
  status           text        NOT NULL    DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  step_seq         integer     NOT NULL    DEFAULT 0,
  step_started_at  timestamptz,
  input            jsonb       NOT NULL,
  state            jsonb       NOT NULL,
  result           jsonb,
  error            text
);

CREATE INDEX IF NOT EXISTS capability_statement_jobs_user_id_idx ON public.capability_statement_jobs(user_id);
CREATE INDEX IF NOT EXISTS capability_statement_jobs_status_idx ON public.capability_statement_jobs(status);

ALTER TABLE public.capability_statement_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages capability statement jobs"
  ON public.capability_statement_jobs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Same reason as generation_issue_reports: tables created outside Supabase's
-- own tooling on this project do not automatically get service_role grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.capability_statement_jobs TO service_role;
