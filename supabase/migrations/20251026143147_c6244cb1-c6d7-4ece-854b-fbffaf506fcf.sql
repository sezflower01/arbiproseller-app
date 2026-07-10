-- Create Keepa batch and items tables for admin upload feature
create table if not exists public.keepa_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  filename text,
  total_rows int default 0,
  processed_rows int default 0,
  status text default 'queued',
  error text
);

create table if not exists public.keepa_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.keepa_batches(id) on delete cascade,
  idx int,
  asin text,
  title text,
  g_store text,
  g_title text,
  g_price numeric(10,2),
  g_link text,
  g_image text,
  amz_asin text,
  amz_title text,
  amz_price numeric(10,2),
  amz_link text,
  amz_image text,
  title_score int,
  image_score int,
  match_score int,
  roi numeric(10,2),
  margin_pct numeric(5,2),
  fees_json jsonb,
  status text default 'queued',
  error text,
  unique(batch_id, idx)
);

alter table public.keepa_batches enable row level security;
alter table public.keepa_items enable row level security;

create policy "Users can manage their own batches" on public.keepa_batches
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users can manage items in their batches" on public.keepa_items
  for all using (
    exists(select 1 from public.keepa_batches b where b.id = batch_id and b.user_id = auth.uid())
  ) with check (
    exists(select 1 from public.keepa_batches b where b.id = batch_id and b.user_id = auth.uid())
  );