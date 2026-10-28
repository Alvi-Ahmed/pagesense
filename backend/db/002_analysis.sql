-- 002: analysis jobs, playbook, catalog status, order flags, post drafts.
-- Additive only: no drops, no deletes. Safe to re-run. Run in the Supabase SQL editor.

-- One row per analysis run (tagging -> classification -> playbook -> catalog -> orders).
create table if not exists analysis_jobs (
  id            uuid primary key default gen_random_uuid(),
  page_id       text not null references pages(id) on delete cascade,
  status        text not null default 'queued'
                check (status in ('queued', 'running', 'done', 'failed')),
  stage         text,                       -- stage currently running
  processed     integer not null default 0, -- progress within the current stage
  total         integer not null default 0,
  failed_count  integer not null default 0, -- items skipped (e.g. dead photo urls)
  error         text,
  error_detail  jsonb,                      -- API response body, for debugging
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
create index if not exists analysis_jobs_page_idx on analysis_jobs (page_id, created_at desc);

-- Patterns computed in code (data) plus Muse Spark's plain-language explanation (summary).
create table if not exists playbooks (
  id          uuid primary key default gen_random_uuid(),
  page_id     text not null references pages(id) on delete cascade,
  data        jsonb not null,
  summary     jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists playbooks_page_idx on playbooks (page_id, created_at desc);

-- Catalog: stock status and the posts each product appears in.
alter table products add column if not exists status text not null default 'in_stock';
do $$ begin
  alter table products add constraint products_status_check
    check (status in ('in_stock', 'pre_order', 'sold_out'));
exception when duplicate_object then null; end $$;
alter table products add column if not exists updated_at timestamptz not null default now();

create table if not exists product_posts (
  product_id  uuid not null references products(id) on delete cascade,
  post_id     text not null references posts(id) on delete cascade,
  primary key (product_id, post_id)
);

-- Orders captured from comments: what is still missing, and contact details.
alter table orders add column if not exists missing_fields text[] not null default '{}';
alter table orders add column if not exists phone text;
alter table orders add column if not exists address text;
alter table orders add column if not exists updated_at timestamptz not null default now();

-- Generated posts. Nothing is published until the owner approves.
create table if not exists post_drafts (
  id              uuid primary key default gen_random_uuid(),
  page_id         text not null references pages(id) on delete cascade,
  source_post_id  text references posts(id) on delete set null,
  caption         text not null,
  language        text not null default 'banglish'
                  check (language in ('bangla', 'english', 'banglish')),
  photo_url       text,                     -- branded photo
  why             jsonb,                    -- "why this works" chips
  status          text not null default 'draft'
                  check (status in ('draft', 'scheduled', 'published', 'failed')),
  scheduled_at    timestamptz,
  fb_post_id      text,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists post_drafts_page_idx on post_drafts (page_id, created_at desc);

alter table analysis_jobs enable row level security;
alter table playbooks     enable row level security;
alter table product_posts enable row level security;
alter table post_drafts   enable row level security;
