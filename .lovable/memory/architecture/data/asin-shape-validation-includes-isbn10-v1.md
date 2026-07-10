---
name: ASIN Shape Validation Includes ISBN-10
description: Any code that regex-validates Amazon ASINs MUST accept both B0-prefixed ASINs AND ISBN-10s; using only ^B0[A-Z0-9]{8}$ misidentifies legitimate book listings as broken
type: constraint
---

# Rule

Any function, regex, guard, or validator that decides "is this a real ASIN?" MUST accept **both** shapes:

```
^(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$
```

- `B0[A-Z0-9]{8}` — modern Amazon ASINs (10 chars starting with `B0`).
- `[0-9]{9}[0-9X]` — ISBN-10 (books). Amazon uses the ISBN-10 as the ASIN for older book listings. Trailing character may be `X` (checksum).

# Why

Discovered while dry-running `repair_sales_orders_asin_for_user` v2: the naive regex `^B0[A-Z0-9]{8}$` flagged **227 legitimate book orders** in a 60-day window as "shape-wrong". Combined with an fnsku_map lookup, that would have silently rewritten valid book ASINs to whatever the SKU-side of fnsku_map had — an automated data-corruption path masquerading as a repair function.

The dry-run saved production. This rule ensures the same class of bug never lands in another function.

# How to apply

- **New code**: use the combined regex above whenever validating ASIN shape. Prefer a shared helper (`isValidAsinShape(s)`) over inline regex.
- **Reviewing existing code**: grep for `B0[A-Z0-9]{8}` or `^B0` in SQL, TS, and edge functions. Any occurrence that lacks the ISBN-10 alternation is a latent bug.
- **Repair / self-heal functions**: never touch a row solely because its ASIN doesn't match the modern shape — always allow ISBN-10 first.
- **Fully broken markers** (`UNKNOWN`, empty string, null) can still be treated as bad — but check them explicitly, not by regex.

# Known safe locations
- `public.repair_sales_orders_asin_for_user` — uses the combined regex (deployed 2026-07-09).

# Related
- `sales_orders` rows with `asin_source = 'fnsku_map_repair'` came from this healer path.
