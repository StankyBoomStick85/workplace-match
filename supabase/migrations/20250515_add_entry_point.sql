ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS entry_point text;
