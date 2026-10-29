-- 004: which analysis stages have completed for each page, and at which version.
-- Additive only. Safe to re-run. Run in the Supabase SQL editor.
-- A stage runs when it has no row here, its row is older than the version in code, or new posts/comments
-- have arrived since completed_at. Until this table exists the pipeline falls back to "run what is missing".
create table if not exists analysis_stages (
  page_id       text not null references pages(id) on delete cascade,
  stage         text not null check (stage in ('tagging', 'classification', 'playbook')),
  version       integer not null,
  completed_at  timestamptz not null default now(),
  primary key (page_id, stage)
);
alter table analysis_stages enable row level security;
