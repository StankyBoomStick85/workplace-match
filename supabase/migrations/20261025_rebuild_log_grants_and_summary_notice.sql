-- 1. profile_rebuild_log was created without service_role grants (see
--    20260927_create_generation_issue_reports.sql: new tables do not
--    automatically receive them, and RLS policies alone are silently not
--    enough). Every rebuild request - the synthesis auto-chain after profile
--    generation and the summary rebuild on a direction change - failed with
--    "permission denied for table profile_rebuild_log", so no job ever started.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_rebuild_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.profile_rebuild_log_id_seq TO service_role;

-- 2. The notice a candidate sees when their employer summary could not be
--    updated and the previous version is still showing (lib/summaryNotice.ts).
--    null = nothing to show. Set when a rebuild is blocked by a check, cannot
--    start, or hits the daily limit; cleared whenever a new summary is stored.
--    { "message": string, "reason": string, "source": string, "at": timestamptz }
ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS employer_summary_notice jsonb;
