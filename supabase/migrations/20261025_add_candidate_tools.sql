-- Named tools, software, and platforms the candidate uses (lib/candidateTools.ts):
-- the de-duplicated union of document_metadata[].tools across their current
-- documents. Written by process-document (on upload), generate-capability
-- (backfill for older documents), and /api/mvp/write (when the document list
-- changes). Read by the employer summary (and its GAP verification), synthesis
-- context, and both scorers.

ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS tools text[] NOT NULL DEFAULT '{}';
