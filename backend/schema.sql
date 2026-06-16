-- PostgreSQL schema for a production Linguapolis service.
create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  display_name text,
  role text not null default 'learner' check (role in ('learner', 'teacher', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists learner_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  character_id text not null,
  level integer not null default 1,
  xp integer not null default 0,
  xp_next integer not null default 100,
  coins integer not null default 0,
  confidence numeric(5,2) not null default 20,
  vocabulary numeric(5,2) not null default 20,
  fluency numeric(5,2) not null default 20,
  accuracy numeric(5,2) not null default 20,
  completed_lessons integer not null default 0,
  updated_at timestamptz not null default now(),
  unique(user_id, character_id)
);

create table if not exists answer_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  profile_id uuid references learner_profiles(id) on delete set null,
  lesson_id text not null,
  prompt_index integer not null,
  answer_text text not null,
  relevance_score integer not null check (relevance_score between 0 and 100),
  vocabulary_score integer not null check (vocabulary_score between 0 and 100),
  structure_score integer not null check (structure_score between 0 and 100),
  fluency_score integer not null check (fluency_score between 0 and 100),
  overall_score integer not null check (overall_score between 0 and 100),
  feedback jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists action_logs (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  session_id uuid,
  event_name text not null,
  payload jsonb not null default '{}'::jsonb,
  page text,
  created_at timestamptz not null default now()
);

create table if not exists skill_history (
  id bigserial primary key,
  profile_id uuid not null references learner_profiles(id) on delete cascade,
  source_type text not null,
  source_id text,
  confidence_delta numeric(5,2) not null default 0,
  vocabulary_delta numeric(5,2) not null default 0,
  fluency_delta numeric(5,2) not null default 0,
  accuracy_delta numeric(5,2) not null default 0,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists answer_attempts_user_created_idx on answer_attempts(user_id, created_at desc);
create index if not exists action_logs_created_idx on action_logs(created_at desc);
create index if not exists action_logs_event_idx on action_logs(event_name, created_at desc);
