ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS document_metadata jsonb NOT NULL DEFAULT '[]'::jsonb;
