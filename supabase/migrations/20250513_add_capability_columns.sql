-- Add AI-generated capability fields to candidate_profiles
ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS capability_summary text,
  ADD COLUMN IF NOT EXISTS predicted_alignment text,
  ADD COLUMN IF NOT EXISTS employer_summary text;
