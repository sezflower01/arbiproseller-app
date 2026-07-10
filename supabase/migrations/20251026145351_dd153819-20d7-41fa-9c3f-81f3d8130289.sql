-- Create tables for ASIN-only batch processing
create table if not exists asin_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  filename text,
  total int default 0,
  processed int default 0,
  status text default 'queued',
  error text
);

create table if not exists asin_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references asin_batches(id) on delete cascade,
  idx int,
  asin text not null,
  -- amazon enrichment
  amz_title text,
  amz_price numeric(10,2),
  amz_image text,
  amz_link text,
  -- retailer (google) result
  g_store text,
  g_title text,
  g_price numeric(10,2),
  g_image text,
  g_link text,
  source text, -- shopping|google
  -- scoring / economics
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

-- Enable RLS
alter table asin_batches enable row level security;
alter table asin_items enable row level security;

-- RLS policies
create policy "Users can manage their own asin batches"
  on asin_batches for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can manage items in their asin batches"
  on asin_items for all
  using (exists(select 1 from asin_batches b where b.id = batch_id and b.user_id = auth.uid()))
  with check (exists(select 1 from asin_batches b where b.id = batch_id and b.user_id = auth.uid()));