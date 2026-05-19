CREATE TABLE IF NOT EXISTS public.error_logs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL    DEFAULT now(),
  route         text        NOT NULL,
  error_message text        NOT NULL,
  error_type    text        NOT NULL,
  user_id       uuid,
  user_email    text,
  severity      text        NOT NULL,
  metadata      jsonb,
  resolved      boolean     NOT NULL    DEFAULT false
);
