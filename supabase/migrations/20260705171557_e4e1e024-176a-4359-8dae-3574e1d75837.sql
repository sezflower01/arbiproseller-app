
ALTER TABLE public.expense_categories ALTER COLUMN user_id DROP NOT NULL;

DROP POLICY IF EXISTS "Users can view their own categories" ON public.expense_categories;
DROP POLICY IF EXISTS "Users can update their own categories" ON public.expense_categories;
DROP POLICY IF EXISTS "Users can delete their own categories" ON public.expense_categories;

CREATE POLICY "Users can view own or standard categories" ON public.expense_categories
  FOR SELECT USING (user_id IS NULL OR auth.uid() = user_id);

CREATE POLICY "Users can update their own categories" ON public.expense_categories
  FOR UPDATE USING (auth.uid() = user_id AND user_id IS NOT NULL);

CREATE POLICY "Users can delete their own categories" ON public.expense_categories
  FOR DELETE USING (auth.uid() = user_id AND user_id IS NOT NULL);

-- Seed standard/global categories from all existing distinct names
INSERT INTO public.expense_categories (user_id, name)
SELECT DISTINCT NULL::uuid, name
FROM public.expense_categories
WHERE name IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.expense_categories ec2
    WHERE ec2.user_id IS NULL AND ec2.name = expense_categories.name
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_global_name
  ON public.expense_categories(name) WHERE user_id IS NULL;
