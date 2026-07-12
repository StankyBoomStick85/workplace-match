ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS capability_entries jsonb;
