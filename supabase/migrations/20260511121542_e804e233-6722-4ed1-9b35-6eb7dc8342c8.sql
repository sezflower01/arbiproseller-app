create table if not exists public.ghost_sku_quarantine (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  asin text not null,
  seller_sku text not null,
  fnsku text null,
  reason text not null,
  previous_listing_status text null,
  previous_available integer null,
  previous_reserved integer null,
  previous_inbound integer null,
  source_function text not null,
  archived_at timestamptz not null default now(),
  raw jsonb null
);

alter table public.ghost_sku_quarantine enable row level security;

create index if not exists idx_ghost_sku_quarantine_user_asin
  on public.ghost_sku_quarantine (user_id, asin, archived_at desc);

create index if not exists idx_ghost_sku_quarantine_sku
  on public.ghost_sku_quarantine (seller_sku);

create unique index if not exists idx_ghost_sku_quarantine_unique_active
  on public.ghost_sku_quarantine (user_id, asin, seller_sku, source_function);

create policy "Users can view their own ghost SKU quarantine"
  on public.ghost_sku_quarantine
  for select
  using (auth.uid() = user_id);

create policy "Users can add their own ghost SKU quarantine records"
  on public.ghost_sku_quarantine
  for insert
  with check (auth.uid() = user_id);
