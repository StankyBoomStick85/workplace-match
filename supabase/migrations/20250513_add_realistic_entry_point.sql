-- Add realistic_entry_point AI output field to candidate_profiles
ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS realistic_entry_point text;
