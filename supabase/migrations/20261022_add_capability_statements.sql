-- Tier 1 capability statements (Phase 1).
--
-- capability_statements: 3-12 core statements, each
--   { statement, evidenceBasis, proof: [{ text, groupIds, evidenceBasis }] }
-- niche_capabilities: specialized skills, each
--   { statement, applicability: [..], evidenceBasis, proof: [...] }
-- evidenceBasis ("documented" | "self_reported" | "mixed") is computed in code
-- from the cited evidence groups; it is never displayed as a badge.
--
-- Phase 1 only shows these on the candidate's own profile page. Employer views
-- are unchanged until Phase 2. Both columns are nullable (NULL = never
-- generated) and must hold a JSON array when set.
ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS capability_statements jsonb,
  ADD COLUMN IF NOT EXISTS niche_capabilities jsonb,
  ADD COLUMN IF NOT EXISTS capability_profile_generated_at timestamptz;

ALTER TABLE public.candidate_profiles
  DROP CONSTRAINT IF EXISTS candidate_profiles_capability_statements_is_array,
  ADD CONSTRAINT candidate_profiles_capability_statements_is_array
    CHECK (capability_statements IS NULL OR jsonb_typeof(capability_statements) = 'array');

ALTER TABLE public.candidate_profiles
  DROP CONSTRAINT IF EXISTS candidate_profiles_niche_capabilities_is_array,
  ADD CONSTRAINT candidate_profiles_niche_capabilities_is_array
    CHECK (niche_capabilities IS NULL OR jsonb_typeof(niche_capabilities) = 'array');
