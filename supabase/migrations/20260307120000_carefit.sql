-- CareFit / openGym durable store (replaces ./data JSON files on Render).
-- Apply with the Supabase SQL editor or `supabase db push`.
-- Service role on the API bypasses RLS; no anon policies on these tables.

create table if not exists public.users (
  id text primary key,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.creds (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists creds_user_id_idx on public.creds (user_id);

create table if not exists public.push_subs (
  endpoint text primary key,
  user_id text not null references public.users(id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists push_subs_user_id_idx on public.push_subs (user_id);

create table if not exists public.invites (
  code text primary key,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.device_links (
  id text primary key,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.plan_requests (
  id text primary key,
  user_id text not null,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists plan_requests_user_id_idx on public.plan_requests (user_id);

create table if not exists public.posts (
  id text primary key,
  user_id text not null,
  doc jsonb not null default '{}'::jsonb,
  created bigint,
  updated_at timestamptz not null default now()
);
create index if not exists posts_user_id_idx on public.posts (user_id);
create index if not exists posts_created_idx on public.posts (created desc);

create table if not exists public.states (
  uid text primary key,
  doc jsonb not null default '{}'::jsonb,
  rev bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.plans (
  uid text primary key,
  doc jsonb not null default '{}'::jsonb,
  rev bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Media object metadata; bytes live in Storage bucket `media` at {uid}/{hash}.{ext}
create table if not exists public.media_objects (
  uid text not null,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  ext text not null,
  mime text not null,
  size bigint not null default 0,
  unreferenced_at bigint,
  created_at timestamptz not null default now(),
  primary key (uid, hash)
);

create table if not exists public.audit (
  id bigserial primary key,
  ts bigint not null,
  ev text not null,
  ok boolean not null default true,
  uid text,
  name text,
  tgt text,
  tname text,
  msg text,
  act text,
  ip text,
  doc jsonb not null default '{}'::jsonb
);
create index if not exists audit_ts_idx on public.audit (ts desc);
create index if not exists audit_ev_idx on public.audit (ev);

create table if not exists public.config (
  key text primary key,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Private bucket for workout media (create once; ignore if already present).
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 52428800)
on conflict (id) do nothing;

alter table public.users enable row level security;
alter table public.creds enable row level security;
alter table public.push_subs enable row level security;
alter table public.invites enable row level security;
alter table public.device_links enable row level security;
alter table public.plan_requests enable row level security;
alter table public.posts enable row level security;
alter table public.states enable row level security;
alter table public.plans enable row level security;
alter table public.media_objects enable row level security;
alter table public.audit enable row level security;
alter table public.config enable row level security;
-- No policies: only the service role (Render API) may read/write.
