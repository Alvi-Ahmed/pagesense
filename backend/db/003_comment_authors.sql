-- 003: who wrote each comment and whether the page answered it.
-- Additive only. Safe to re-run. Run in the Supabase SQL editor BEFORE deploying the code that uses it,
-- then re-sync the page (the sync fills these columns; old rows stay false/null until then).
alter table comments add column if not exists parent_id text;                      -- the comment this one replies to
alter table comments add column if not exists is_page   boolean not null default false; -- written by the page itself
alter table comments add column if not exists answered  boolean not null default false; -- the page replied to it
