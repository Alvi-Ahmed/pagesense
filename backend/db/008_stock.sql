-- 008: stock per variant (item 21). Additive only. Safe to re-run. Run in the Supabase SQL editor.
-- Until it is run, importing and editing stock report that it is not ready; everything else keeps working.

-- One row per product + size + color. size and color are empty strings when a product has none.
create table if not exists stock_variants (
  id          uuid primary key default gen_random_uuid(),
  page_id     text not null references pages(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  size        text not null default '',
  color       text not null default '',
  quantity    integer not null default 0 check (quantity >= 0),
  sku         text,
  updated_at  timestamptz not null default now(),
  unique (product_id, size, color)
);
create index if not exists stock_variants_page_idx on stock_variants (page_id, product_id);

-- What confirming an order took out of stock, so that undoing it can put exactly that back (one move per order).
create table if not exists stock_moves (
  id          uuid primary key default gen_random_uuid(),
  page_id     text not null references pages(id) on delete cascade,
  order_id    uuid not null unique references orders(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  variant_id  uuid references stock_variants(id) on delete set null,
  quantity    integer not null check (quantity > 0),
  created_at  timestamptz not null default now()
);

alter table pages add column if not exists low_stock_threshold integer not null default 3 check (low_stock_threshold >= 0);
alter table pages add column if not exists stock_layout jsonb; -- the owner's sheet columns, so the Excel download matches it

alter table stock_variants enable row level security;
alter table stock_moves    enable row level security;
