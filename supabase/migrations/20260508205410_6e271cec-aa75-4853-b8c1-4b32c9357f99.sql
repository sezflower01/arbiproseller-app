create table if not exists public.fba_eligibility_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  seller_id text not null,
  marketplace_id text not null,
  asin text not null,
  eligible boolean not null,
  blocking_issues jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  fba_block_reason text,
  raw jsonb,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, seller_id, marketplace_id, asin)
);

alter table public.fba_eligibility_cache enable row level security;

create policy "Users select own eligibility"
  on public.fba_eligibility_cache for select
  using (auth.uid() = user_id);

create policy "Users insert own eligibility"
  on public.fba_eligibility_cache for insert
  with check (auth.uid() = user_id);

create policy "Users update own eligibility"
  on public.fba_eligibility_cache for update
  using (auth.uid() = user_id);

create policy "Users delete own eligibility"
  on public.fba_eligibility_cache for delete
  using (auth.uid() = user_id);

create index if not exists idx_fba_elig_cache_lookup
  on public.fba_eligibility_cache (user_id, marketplace_id, asin);

drop trigger if exists trg_fba_elig_cache_updated_at on public.fba_eligibility_cache;
create trigger trg_fba_elig_cache_updated_at
before update on public.fba_eligibility_cache
for each row execute function public.update_updated_at_column();

alter table public.created_listings
  add column if not exists fba_blocked boolean not null default false,
  add column if not exists fba_block_reason text;

alter table public.inventory
  add column if not exists fba_blocked boolean not null default false,
  add column if not exists fba_block_reason text;

create index if not exists idx_created_listings_fba_blocked
  on public.created_listings (user_id) where fba_blocked = true;

create index if not exists idx_inventory_fba_blocked
  on public.inventory (user_id) where fba_blocked = true;