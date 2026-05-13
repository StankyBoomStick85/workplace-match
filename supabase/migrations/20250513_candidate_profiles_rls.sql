-- Enable RLS on candidate_profiles (safe to run even if already enabled)
ALTER TABLE public.candidate_profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if present so this migration is idempotent
DROP POLICY IF EXISTS "candidates can select own profile" ON public.candidate_profiles;
DROP POLICY IF EXISTS "candidates can insert own profile" ON public.candidate_profiles;
DROP POLICY IF EXISTS "candidates can update own profile" ON public.candidate_profiles;

-- Authenticated users can read their own row
CREATE POLICY "candidates can select own profile"
  ON public.candidate_profiles
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Authenticated users can create their own row
CREATE POLICY "candidates can insert own profile"
  ON public.candidate_profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Authenticated users can update their own row
CREATE POLICY "candidates can update own profile"
  ON public.candidate_profiles
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
