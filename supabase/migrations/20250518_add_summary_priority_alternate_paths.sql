ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS summary_priority text,
  ADD COLUMN IF NOT EXISTS alternate_paths jsonb;
