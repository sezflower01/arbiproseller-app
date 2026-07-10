# Module Access Control — Operator Guide

This is the source of truth for the per-user module permission system.
Use it to grant/revoke access until the admin UI ships.

## Model summary

- **Modules** (`app_module`): `repricer`, `inventory`, `reports`,
  `supplier_discovery`, `product_library`, `personalhour`, `settings`,
  `admin_panel`.
- **Actions** (`app_action`): `view`, `run`, `edit`, `admin`.
- **Resolution rule** — `public.has_module_access(user_id, module, action)`:
  1. If user has `user_roles.role = 'admin'` → **allowed**, always.
  2. Else, allowed only if a matching row exists in `user_module_access`.
- **No deny rows.** Revoke = delete the row.
- **Default for new users:** zero module access. Admins must explicitly grant.

Both the React hook (`useModuleAccess`) and the edge-function helper
(`checkModuleAccess`) use this single function, so UI visibility and backend
enforcement can never disagree.

---

## Backend enforcement coverage (current)

| Edge function | Check |
| --- | --- |
| `personalhour-product-data` | `personalhour:view` |
| `discover-source-candidates` | `supplier_discovery:run` |
| `auto-extract-top-candidates` | `supplier_discovery:run` (against run owner) |
| `extract-product-price` | `supplier_discovery:run` |
| `repricer-batch-update` | `repricer:run` (skipped for `internal:true` cron) |
| `bulk-update-repricer-bounds` | `repricer:edit` |
| `admin-manage-roles`, `admin-manage-account`, etc. | already admin-gated; admin role bypasses every module check |

Everything else relies on standard RLS (`user_id = auth.uid()`), which is
sufficient for per-user data isolation.

---

## SQL cheat sheet

Run these from the Supabase SQL editor.

### Find a user

```sql
SELECT id, email FROM auth.users WHERE email = 'user@example.com';
```

### Make a user admin (full access to everything)

```sql
INSERT INTO public.user_roles (user_id, role)
VALUES ('<user_id>', 'admin')
ON CONFLICT DO NOTHING;
```

### Revoke admin

```sql
DELETE FROM public.user_roles
WHERE user_id = '<user_id>' AND role = 'admin';
```

### Grant view-only access to a module

```sql
INSERT INTO public.user_module_access (user_id, module, action)
VALUES ('<user_id>', 'repricer', 'view')
ON CONFLICT DO NOTHING;
```

### Grant view + run (operator profile, no edit rights)

```sql
INSERT INTO public.user_module_access (user_id, module, action) VALUES
  ('<user_id>', 'repricer', 'view'),
  ('<user_id>', 'repricer', 'run')
ON CONFLICT DO NOTHING;
```

### Grant full access to a single module (view + run + edit)

```sql
INSERT INTO public.user_module_access (user_id, module, action) VALUES
  ('<user_id>', 'inventory', 'view'),
  ('<user_id>', 'inventory', 'run'),
  ('<user_id>', 'inventory', 'edit')
ON CONFLICT DO NOTHING;
```

### Revoke a single action

```sql
DELETE FROM public.user_module_access
WHERE user_id = '<user_id>'
  AND module  = 'repricer'
  AND action  = 'run';
```

### Revoke everything for one module

```sql
DELETE FROM public.user_module_access
WHERE user_id = '<user_id>' AND module = 'personalhour';
```

### Grant access by email (one-shot)

```sql
INSERT INTO public.user_module_access (user_id, module, action)
SELECT id, 'reports', 'view' FROM auth.users
WHERE email = 'user@example.com'
ON CONFLICT DO NOTHING;
```

### Audit: what can this user do?

```sql
SELECT module, action FROM public.user_module_access
WHERE user_id = '<user_id>'
ORDER BY module, action;
```

### Audit: who has access to a sensitive module?

```sql
SELECT u.email, uma.action
FROM public.user_module_access uma
JOIN auth.users u ON u.id = uma.user_id
WHERE uma.module = 'personalhour';
```

### Verify a check from SQL (matches what the backend evaluates)

```sql
SELECT public.has_module_access('<user_id>', 'personalhour'::app_module, 'view'::app_action);
```

---

## Regression test checklist

- [ ] No-grant user → cannot reach `/PersonalHour` (redirected to `/tools` with toast).
- [ ] No-grant user → `personalhour-product-data` returns `403 MODULE_ACCESS_DENIED`.
- [ ] User with `repricer:view` only → cannot call `repricer-batch-update` (403).
- [ ] User with `repricer:run` → can submit batch updates.
- [ ] Admin → every check passes regardless of `user_module_access` rows.
- [ ] Internal cron (`internal:true` body flag on `repricer-batch-update`) still works.

Automated coverage lives in
`supabase/functions/_shared/module-access-guard_test.ts`.
