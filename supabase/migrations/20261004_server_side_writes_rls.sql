-- =============================================================================
-- Server-side writes: tighten RLS once the app no longer writes these tables
-- from the browser.  DO NOT RUN THIS BEFORE THE CODE IS DEPLOYED.
--
-- Run order (Supabase SQL editor, one part at a time):
--   0. Deploy the commits that move these writes to /api/interests,
--      /api/matches, /api/messages, /api/notifications, /api/admin-events and
--      the signed-URL profile photo code. Confirm in production that sending a
--      message, marking interest, and the notification bell all still work.
--   1. PART A - match_scores / adzuna_cache. The browser never writes either
--      table, so this is safe as soon as you choose.
--   2. PART B - drop browser INSERT/UPDATE on matches, notifications,
--      match_messages, admin_activity_events, and interests UPDATE. Only after
--      step 0: until the new code is live, the old code still writes these
--      directly and would start failing. (A tab left open on the old code will
--      fail these writes until it is refreshed.)
--   3. PART C - make the profile-pictures bucket private. Only after step 0:
--      the new code serves the candidate their own photo as a signed URL.
--      Run the PART C inspection query first.
--
-- Untouched on purpose: every SELECT policy on match_messages and
-- notifications (Supabase Realtime delivers live messages and the
-- notification bell through them), the notifications DELETE policy (the
-- bell's dismiss button still deletes the user's own rows directly), and
-- "candidates read own scores" on match_scores (the job map reads its own
-- scores directly).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- PART A - match_scores and adzuna_cache: writes are service_role only.
-- Both had a policy named "service role manages ..." that was created without
-- TO service_role, so it applied to role {public}: every signed-in user could
-- read and write every row.
-- -----------------------------------------------------------------------------
BEGIN;

DROP POLICY IF EXISTS "service role manages scores" ON public.match_scores;
CREATE POLICY "service role manages scores"
  ON public.match_scores FOR ALL TO service_role
  USING (true) WITH CHECK (true);
-- "candidates read own scores" (SELECT, auth.uid() = candidate_id) is kept.
REVOKE INSERT, UPDATE, DELETE ON public.match_scores FROM anon, authenticated;

DROP POLICY IF EXISTS "service role manages adzuna cache" ON public.adzuna_cache;
CREATE POLICY "service role manages adzuna cache"
  ON public.adzuna_cache FOR ALL TO service_role
  USING (true) WITH CHECK (true);
-- Keep the job cache publicly readable (it was readable through the old
-- {public} ALL policy).
DO $$ BEGIN
  CREATE POLICY "anyone can read adzuna cache"
    ON public.adzuna_cache FOR SELECT TO anon, authenticated
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
REVOKE INSERT, UPDATE, DELETE ON public.adzuna_cache FROM anon, authenticated;

COMMIT;


-- -----------------------------------------------------------------------------
-- PART B - browser INSERT/UPDATE removed; the server routes write these now
-- with the service role (which bypasses RLS and keeps its own grants).
-- -----------------------------------------------------------------------------
BEGIN;

-- Safety stop: an ALL-command policy for authenticated/public on these tables
-- also grants SELECT, and dropping it would break Realtime. If one exists this
-- aborts the whole part so it can be split by hand instead of guessed at.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('matches', 'notifications', 'match_messages', 'admin_activity_events', 'interests')
      AND cmd = 'ALL'
      AND roles && ARRAY['authenticated', 'public']::name[]
  LOOP
    RAISE EXCEPTION 'Policy "%" on public.% is FOR ALL (it also grants SELECT). Split it by hand before running PART B.', r.policyname, r.tablename;
  END LOOP;
END $$;

-- Drop every INSERT/UPDATE policy for authenticated/public on the four tables,
-- and the UPDATE policy on interests. Policies are found by table + command,
-- not by name, so nothing depends on how they happen to be named. SELECT and
-- DELETE policies are never matched by this.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname, cmd FROM pg_policies
    WHERE schemaname = 'public'
      AND roles && ARRAY['authenticated', 'public']::name[]
      AND (
        (tablename IN ('matches', 'notifications', 'match_messages', 'admin_activity_events') AND cmd IN ('INSERT', 'UPDATE'))
        OR (tablename = 'interests' AND cmd = 'UPDATE')
      )
  LOOP
    RAISE NOTICE 'Dropping % policy "%" on public.%', r.cmd, r.policyname, r.tablename;
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- Grants too, so a future permissive policy can't silently reopen these.
-- SELECT (Realtime) and DELETE (notification dismiss) grants are kept.
REVOKE INSERT, UPDATE ON public.matches               FROM anon, authenticated;
REVOKE INSERT, UPDATE ON public.notifications         FROM anon, authenticated;
REVOKE INSERT, UPDATE ON public.match_messages        FROM anon, authenticated;
REVOKE INSERT, UPDATE ON public.admin_activity_events FROM anon, authenticated;
REVOKE UPDATE         ON public.interests             FROM anon, authenticated;

COMMIT;

-- OPTIONAL, same deploy: the new code also no longer INSERTs or DELETEs
-- interests, or DELETEs matches, from the browser (api/interests does both).
-- Uncomment to close those too.
-- DO $$
-- DECLARE r record;
-- BEGIN
--   FOR r IN
--     SELECT tablename, policyname FROM pg_policies
--     WHERE schemaname = 'public'
--       AND roles && ARRAY['authenticated', 'public']::name[]
--       AND ((tablename = 'interests' AND cmd IN ('INSERT', 'DELETE')) OR (tablename = 'matches' AND cmd = 'DELETE'))
--   LOOP
--     EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
--   END LOOP;
-- END $$;
-- REVOKE INSERT, DELETE ON public.interests FROM anon, authenticated;
-- REVOKE DELETE ON public.matches FROM anon, authenticated;


-- -----------------------------------------------------------------------------
-- PART C - profile photos: private bucket.
--
-- Step C1 (inspect, read-only): list the storage policies that touch this
-- bucket. Making the bucket private only turns off the public-URL endpoint; a
-- storage.objects SELECT policy that lets any signed-in user read
-- profile-pictures would still let an employer download a candidate's photo
-- through the authenticated storage API. Every SELECT/ALL policy listed here
-- must be limited to the owner's own folder, e.g.
--   bucket_id = 'profile-pictures' AND (storage.foldername(name))[1] = auth.uid()::text
-- (the owner-folder SELECT is still needed: uploads use upsert, which reads
-- the existing object).
--
--   SELECT policyname, cmd, roles, qual, with_check
--   FROM pg_policies
--   WHERE schemaname = 'storage' AND tablename = 'objects'
--     AND (qual ILIKE '%profile-pictures%' OR with_check ILIKE '%profile-pictures%');
--
-- Step C2 (apply): make the bucket private. Signed URLs minted by the server
-- (lib/profilePhotos.ts) keep working; the old public URLs stop working.
-- -----------------------------------------------------------------------------
UPDATE storage.buckets SET public = false WHERE id = 'profile-pictures';


-- -----------------------------------------------------------------------------
-- Verify (read-only) after running:
--   SELECT tablename, policyname, cmd, roles FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('match_scores','adzuna_cache','matches','notifications','match_messages','admin_activity_events','interests')
--   ORDER BY tablename, cmd;
--   SELECT id, public FROM storage.buckets WHERE id = 'profile-pictures';
-- -----------------------------------------------------------------------------
