ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS is_approved boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS correction_notes text;
