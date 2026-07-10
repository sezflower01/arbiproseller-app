-- Create profiles table linked to Supabase auth users
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  first_name text not null,
  last_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable Row Level Security
alter table public.profiles enable row level security;

-- RLS Policy: Users can view their own profile
create policy "Users can view their own profile"
on public.profiles for select
using (auth.uid() = id);

-- RLS Policy: Users can update their own profile
create policy "Users can update their own profile"
on public.profiles for update
using (auth.uid() = id);

-- RLS Policy: Users can insert their own profile
create policy "Users can insert their own profile"
on public.profiles for insert
with check (auth.uid() = id);

-- Create index for faster lookups
create index idx_profiles_email on public.profiles(email);

-- Update trigger for updated_at
create trigger update_profiles_updated_at
before update on public.profiles
for each row
execute function public.update_modified_column();