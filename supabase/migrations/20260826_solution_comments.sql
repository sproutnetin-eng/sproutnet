-- Solution detail page comments (mirrors blog_comments).
-- Apply in the Supabase SQL editor, then refresh the Solutions pages.

create extension if not exists "pgcrypto";

create table if not exists public.solution_comments (
  id uuid primary key default gen_random_uuid(),
  solution_id uuid not null references public.submissions(id) on delete cascade,
  author_id uuid not null references public.users(id) on delete cascade,
  body text not null,
  parent_comment_id uuid references public.solution_comments(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists solution_comments_solution_id_created_at_idx
  on public.solution_comments (solution_id, created_at asc);

create index if not exists solution_comments_parent_comment_id_idx
  on public.solution_comments (parent_comment_id);

-- Enable Row Level Security (server API uses the service role; these
-- policies keep direct browser access safe as well).
ALTER TABLE public.solution_comments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'solution_comments' AND policyname = 'Allow public read on solution_comments'
  ) THEN
    CREATE POLICY "Allow public read on solution_comments" ON public.solution_comments
      FOR SELECT USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'solution_comments' AND policyname = 'Allow authenticated insert on solution_comments'
  ) THEN
    CREATE POLICY "Allow authenticated insert on solution_comments" ON public.solution_comments
      FOR INSERT WITH CHECK (auth.uid() = author_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'solution_comments' AND policyname = 'Allow author delete on solution_comments'
  ) THEN
    CREATE POLICY "Allow author delete on solution_comments" ON public.solution_comments
      FOR DELETE USING (auth.uid() = author_id);
  END IF;
END $$;
