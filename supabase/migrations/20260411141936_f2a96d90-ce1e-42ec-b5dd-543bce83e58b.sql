
-- Create role enum for team members
CREATE TYPE public.team_role AS ENUM ('owner', 'admin', 'manager', 'viewer');

-- Create status enum for invitations
CREATE TYPE public.team_invite_status AS ENUM ('pending', 'accepted', 'revoked');

-- Create team_members table
CREATE TABLE public.team_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL,
  member_user_id UUID DEFAULT NULL,
  email TEXT NOT NULL,
  role team_role NOT NULL DEFAULT 'viewer',
  status team_invite_status NOT NULL DEFAULT 'pending',
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, email)
);

-- Enable RLS
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- Owner can do everything with their team
CREATE POLICY "Owners can view their team"
  ON public.team_members FOR SELECT
  USING (auth.uid() = owner_id);

CREATE POLICY "Owners can invite members"
  ON public.team_members FOR INSERT
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Owners can update members"
  ON public.team_members FOR UPDATE
  USING (auth.uid() = owner_id);

CREATE POLICY "Owners can remove members"
  ON public.team_members FOR DELETE
  USING (auth.uid() = owner_id);

-- Members can view their own membership
CREATE POLICY "Members can view own membership"
  ON public.team_members FOR SELECT
  USING (auth.uid() = member_user_id);

-- Add updated_at trigger
CREATE TRIGGER update_team_members_updated_at
  BEFORE UPDATE ON public.team_members
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
