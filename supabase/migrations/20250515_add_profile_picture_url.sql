ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS profile_picture_url text;
