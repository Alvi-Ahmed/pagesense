-- PageSense schema (Supabase Postgres). Run in the Supabase SQL editor.
-- The backend uses the service-role key, so RLS is enabled with no policies:
-- the anon key can read nothing.

create extension if not exists pgcrypto;

create table if not exists pages (
  id            text primary key,              -- Facebook page id
  name          text,
  access_token  text,                          -- page token; never expose to the web app
  language      text,                          -- bangla | english | banglish
  voice_notes   text,                          -- learned seller voice
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists posts (
  id               text primary key,           -- Facebook post id
  page_id          text not null references pages(id) on delete cascade,
  message          text,
  photo_url        text,
  created_time     timestamptz,
  reactions        integer not null default 0,
  comments_count   integer not null default 0,
  shares           integer not null default 0,
  engagement_score numeric not null default 0,
  is_boosted       boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists posts_page_time_idx on posts (page_id, created_time desc);
create index if not exists posts_page_score_idx on posts (page_id, engagement_score desc);

create table if not exists comments (
  id            text primary key,              -- Facebook comment id
  post_id       text not null references posts(id) on delete cascade,
  message       text,
  created_time  timestamptz,
  intent        text,                          -- e.g. order | price_query | question | praise | other
  size          text,
  color         text,
  created_at    timestamptz not null default now()
);
create index if not exists comments_post_idx on comments (post_id);
create index if not exists comments_intent_idx on comments (intent);

create table if not exists post_tags (
  post_id         text primary key references posts(id) on delete cascade,
  product_type    text,
  product_phrase  text,                        -- noun phrase for SAM 3.1
  worn_or_flat    text check (worn_or_flat in ('worn', 'flat', 'unknown')),
  background      text,
  price_shown     boolean,
  offer_type      text,
  created_at      timestamptz not null default now()
);

create table if not exists products (
  id            uuid primary key default gen_random_uuid(),
  page_id       text not null references pages(id) on delete cascade,
  name          text not null,
  product_type  text,
  price         numeric,
  sizes         text[] not null default '{}',
  colors        text[] not null default '{}',
  photo_url     text,
  source_post_id text references posts(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists products_page_idx on products (page_id);

create table if not exists orders (
  id            uuid primary key default gen_random_uuid(),
  page_id       text not null references pages(id) on delete cascade,
  product_id    uuid references products(id) on delete set null,
  comment_id    text references comments(id) on delete set null,
  customer_name text,
  customer_fb_id text,
  quantity      integer not null default 1,
  size          text,
  color         text,
  status        text not null default 'pending'
                check (status in ('pending', 'confirmed', 'fulfilled', 'cancelled')),  -- owner approves
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists orders_page_status_idx on orders (page_id, status);

alter table pages     enable row level security;
alter table posts     enable row level security;
alter table comments  enable row level security;
alter table post_tags enable row level security;
alter table products  enable row level security;
alter table orders    enable row level security;
