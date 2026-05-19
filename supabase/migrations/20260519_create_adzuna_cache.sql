CREATE TABLE IF NOT EXISTS public.adzuna_cache (
  id          text        PRIMARY KEY,
  title       text        NOT NULL,
  company     text,
  location    text,
  lat         numeric,
  lng         numeric,
  salary_min  numeric,
  salary_max  numeric,
  job_type    text,
  url         text        NOT NULL,
  description text,
  region      text        NOT NULL,
  cached_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '6 hours')
);

CREATE INDEX ON public.adzuna_cache(region);
CREATE INDEX ON public.adzuna_cache(expires_at);
