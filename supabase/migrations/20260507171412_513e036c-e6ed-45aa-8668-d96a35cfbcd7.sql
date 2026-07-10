
create table if not exists public.asin_dimensions_cache (
  asin text not null,
  marketplace text not null default 'US',
  package_length numeric, package_width numeric, package_height numeric, package_dim_unit text,
  package_weight numeric, package_weight_unit text,
  item_length numeric, item_width numeric, item_height numeric, item_dim_unit text,
  item_weight numeric, item_weight_unit text,
  source text,
  fetched_at timestamptz not null default now(),
  primary key (asin, marketplace)
);
alter table public.asin_dimensions_cache enable row level security;
create policy "Authenticated read dims cache"
  on public.asin_dimensions_cache for select
  to authenticated using (true);
