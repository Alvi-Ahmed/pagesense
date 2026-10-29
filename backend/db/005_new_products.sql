-- 005: products created from uploaded photos, and drafts linked to them.
-- Additive only. Safe to re-run. Run in the Supabase SQL editor.
-- Item 6 (catalog) extends this table further. Until it is applied, saving a new product keeps stock, offer,
-- photos and the photo analysis inside the draft's `why` json instead of in their own columns.
alter table products add column if not exists stock       integer;
alter table products add column if not exists offer       text;
alter table products add column if not exists photo_paths text[] not null default '{}'; -- Storage paths in bucket product-photos
alter table products add column if not exists analysis    jsonb;                         -- what the model saw in the photos
alter table products add column if not exists source      text not null default 'upload';

alter table post_drafts add column if not exists product_id uuid references products(id) on delete set null;
create index if not exists post_drafts_product_idx on post_drafts (product_id);
