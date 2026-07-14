CREATE TABLE IF NOT EXISTS public.approved_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  note text,
  source_request_id uuid REFERENCES public.access_requests(id) ON DELETE SET NULL
);

ALTER TABLE public.approved_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages approved emails"
  ON public.approved_emails FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- public.users currently has no RLS at all, and ApplicantAuthForm/EmployerAuthForm
-- upsert their own row directly from the browser (anon key) right after signUp().
-- That write path lets anyone bypass the approved_emails allowlist entirely by
-- calling the Supabase client directly, so it needs to be closed off: from now on,
-- public.users rows may only be created/modified by the service role, via server
-- routes (app/api/user/set-role) that enforce the allowlist check.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages users"
  ON public.users FOR ALL TO service_role
  USING (true) WITH CHECK (true);
