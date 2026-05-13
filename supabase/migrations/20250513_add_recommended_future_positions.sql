-- Replace predicted_alignment and realistic_entry_point with recommended_position and future_positions
ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS recommended_position text,
  ADD COLUMN IF NOT EXISTS future_positions text;
