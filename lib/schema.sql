create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  role text not null check (role in ('candidate', 'employer', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.candidate_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  display_name text,
  zip_code text,
  search_radius integer,
  desired_pay_min numeric,
  pay_type text,
  job_types text[] default '{}',
  shifts text[] default '{}',
  work_preference text,
  capability_tags text[] default '{}',
  experience_level text,
  summary text,
  visibility text,
  created_at timestamptz not null default now()
);

create table if not exists public.employer_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  company_name text,
  industry text,
  company_size text,
  contact_name text,
  contact_email text,
  location_zip text,
  hiring_radius integer,
  verified boolean not null default false,
  member_status text,
  created_at timestamptz not null default now()
);

create table if not exists public.job_posts (
  id uuid primary key default gen_random_uuid(),
  employer_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  location_zip text,
  pay_min numeric,
  pay_max numeric,
  pay_type text,
  job_type text,
  shift text,
  work_setting text,
  required_capabilities text[] default '{}',
  preferred_capabilities text[] default '{}',
  experience_level text,
  summary text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.interests (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references public.users(id) on delete cascade,
  to_user_id uuid not null references public.users(id) on delete cascade,
  job_id uuid references public.job_posts(id) on delete cascade,
  status text not null check (status in ('pending', 'mutual', 'declined')),
  created_at timestamptz not null default now(),
  unique (from_user_id, to_user_id, job_id)
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.users(id) on delete cascade,
  employer_id uuid not null references public.users(id) on delete cascade,
  job_id uuid references public.job_posts(id) on delete cascade,
  pay_match numeric,
  location_match numeric,
  capability_match numeric,
  score numeric,
  status text,
  created_at timestamptz not null default now(),
  unique (candidate_id, employer_id, job_id)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null,
  message text not null,
  read boolean not null default false,
  related_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.match_messages (
  id uuid primary key default gen_random_uuid(),
  applicant_id uuid not null references public.users(id) on delete cascade,
  employer_id uuid not null references public.users(id) on delete cascade,
  job_id uuid references public.job_posts(id) on delete cascade,
  sender_role text not null check (sender_role in ('applicant', 'employer')),
  sender_email text,
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_activity_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  user_role text,
  job_id uuid,
  applicant_id uuid,
  employer_id uuid,
  metadata jsonb default '{}',
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
