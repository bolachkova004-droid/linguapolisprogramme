-- PostgreSQL / Supabase starting schema for Linguapolis v3.
-- Authentication and row-level security policies must be added before production use.
create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  display_name text,
  role text not null default 'learner' check (role in ('learner', 'teacher', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists learner_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  character_id text not null,
  level integer not null default 1 check (level >= 1),
  xp integer not null default 0 check (xp >= 0),
  xp_next integer not null default 100 check (xp_next > 0),
  coins integer not null default 0 check (coins >= 0),
  confidence numeric(5,2) not null default 20 check (confidence between 0 and 100),
  vocabulary numeric(5,2) not null default 20 check (vocabulary between 0 and 100),
  fluency numeric(5,2) not null default 20 check (fluency between 0 and 100),
  accuracy numeric(5,2) not null default 20 check (accuracy between 0 and 100),
  completed_lessons integer not null default 0 check (completed_lessons >= 0),
  streak integer not null default 0 check (streak >= 0),
  last_lesson_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, character_id)
);

create table if not exists lesson_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  profile_id uuid not null references learner_profiles(id) on delete cascade,
  client_session_id text,
  lesson_id text not null,
  status text not null default 'started' check (status in ('started', 'completed', 'abandoned')),
  answers_count integer not null default 0 check (answers_count >= 0),
  average_score integer check (average_score between 0 and 100),
  reward_xp integer not null default 0 check (reward_xp >= 0),
  reward_coins integer not null default 0 check (reward_coins >= 0),
  reward_claimed_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(profile_id, client_session_id)
);

create table if not exists answer_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  profile_id uuid not null references learner_profiles(id) on delete cascade,
  lesson_attempt_id uuid not null references lesson_attempts(id) on delete cascade,
  lesson_id text not null,
  prompt_index integer not null check (prompt_index >= 0),
  prompt_text text,
  task_text text,
  answer_text text not null check (char_length(answer_text) between 1 and 2000),
  relevance_score integer not null check (relevance_score between 0 and 100),
  vocabulary_score integer not null check (vocabulary_score between 0 and 100),
  structure_score integer not null check (structure_score between 0 and 100),
  fluency_score integer not null check (fluency_score between 0 and 100),
  overall_score integer not null check (overall_score between 0 and 100),
  target_used boolean not null default false,
  evaluation_method text not null default 'heuristic',
  evaluation_version text not null default 'v3',
  feedback jsonb not null default '[]'::jsonb,
  skill_gains jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(lesson_attempt_id, prompt_index)
);

create table if not exists action_logs (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  profile_id uuid references learner_profiles(id) on delete set null,
  session_id text,
  event_name text not null,
  payload jsonb not null default '{}'::jsonb,
  page text,
  app_version text,
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

create table if not exists profile_unlocks (
  id bigserial primary key,
  profile_id uuid not null references learner_profiles(id) on delete cascade,
  skill_key text not null,
  milestone_value integer not null check (milestone_value between 0 and 100),
  unlock_key text not null,
  unlocked_at timestamptz not null default now(),
  unique(profile_id, skill_key, milestone_value)
);

create index if not exists learner_profiles_user_idx on learner_profiles(user_id);
create index if not exists lesson_attempts_profile_started_idx on lesson_attempts(profile_id, started_at desc);
create index if not exists answer_attempts_user_created_idx on answer_attempts(user_id, created_at desc);
create index if not exists answer_attempts_lesson_idx on answer_attempts(lesson_id, created_at desc);
create index if not exists action_logs_created_idx on action_logs(created_at desc);
create index if not exists action_logs_event_idx on action_logs(event_name, created_at desc);
create index if not exists action_logs_user_idx on action_logs(user_id, created_at desc);
create index if not exists skill_history_profile_idx on skill_history(profile_id, created_at desc);

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at before update on users
for each row execute function set_updated_at();

drop trigger if exists learner_profiles_set_updated_at on learner_profiles;
create trigger learner_profiles_set_updated_at before update on learner_profiles
for each row execute function set_updated_at();
