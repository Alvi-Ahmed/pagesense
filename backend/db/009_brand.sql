-- 009: brand settings and branded photos (item 10). Additive only. Safe to re-run. Run in the Supabase SQL editor.
-- Until it is run, saving a brand or attaching a branded photo to a draft reports that it is not ready; previews work.
alter table pages add column if not exists brand jsonb;                     -- { shop_name, color, logo } (logo is a storage ref)
alter table post_drafts add column if not exists branded_url text;          -- the branded image, a storage ref
alter table post_drafts add column if not exists branding jsonb;            -- the settings it was made with
