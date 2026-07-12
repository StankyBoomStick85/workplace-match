ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS pending_evidence_groups jsonb,
  ADD COLUMN IF NOT EXISTS capability_generation_status text;
