-- 006: the catalog (items 6, 8, 18). Additive only. Safe to re-run. Run in the Supabase SQL editor.
-- It also includes everything 005 adds, so 005 does not have to be run separately.
-- Until it is run the catalog still works on the original columns (the product phrase is the name, the source is
-- inferred from source_post_id, offer and stock are not kept), caption updates are not saved, and the catalog
-- stage does not run automatically in the analysis pipeline.

alter table products add column if not exists product_phrase text;                    -- what the photo shows, e.g. "white chunky sneakers"
alter table products add column if not exists offer          text;
alter table products add column if not exists stock          integer;
alter table products add column if not exists photo_paths    text[] not null default '{}'; -- Storage paths (uploaded products)
alter table products add column if not exists analysis       jsonb;                         -- what the model saw in the photos
alter table products add column if not exists source         text not null default 'uploaded';
update products set source = 'uploaded' where source = 'upload';
alter table products alter column source set default 'uploaded';
do $$ begin
  alter table products add constraint products_source_check check (source in ('uploaded', 'extracted'));
exception when duplicate_object then null; end $$;
create index if not exists products_page_status_idx on products (page_id, status);
create index if not exists product_posts_post_idx on product_posts (post_id);

alter table post_drafts add column if not exists product_id uuid references products(id) on delete set null;
create index if not exists post_drafts_product_idx on post_drafts (product_id);

-- Suggested caption changes for the posts of a product that sold out (or came back): the owner reviews each one.
create table if not exists caption_updates (
  id               uuid primary key default gen_random_uuid(),
  page_id          text not null references pages(id) on delete cascade,
  product_id       uuid not null references products(id) on delete cascade,
  post_id          text not null references posts(id) on delete cascade,
  kind             text not null check (kind in ('sold_out', 'restock')),
  original_caption text,
  caption          text not null,
  similar          jsonb,            -- the in-stock product the caption points to, if any
  created_at       timestamptz not null default now()
);
create index if not exists caption_updates_product_idx on caption_updates (product_id, kind, created_at desc);
alter table caption_updates enable row level security;

-- The pipeline records a catalog stage too.
alter table analysis_stages drop constraint if exists analysis_stages_stage_check;
alter table analysis_stages add constraint analysis_stages_stage_check
  check (stage in ('tagging', 'classification', 'playbook', 'catalog'));
