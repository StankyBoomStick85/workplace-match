ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS education_level text;
