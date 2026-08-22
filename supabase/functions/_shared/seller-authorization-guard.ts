/**
 * Ownership guard for `seller_authorizations`.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The table is UNIQUE(seller_id, marketplace_id) -- the constraint does NOT
 * include user_id. Both OAuth completion paths then upsert with
 * `onConflict: "seller_id,marketplace_id"`, and an ON CONFLICT UPDATE rewrites
 * every column in the payload, `user_id` among them.
 *
 * So any account that authorized an Amazon seller already linked to someone
 * else silently took the row -- and with it the refresh token, the automated
 * sync loop (which iterates seller_authorizations), and effectively that
 * seller's data. No error, no log, nothing for either party to notice.
 *
 * Not hypothetical. Verified live 2026-08-21: a second login on this platform
 * held 1,511 of the primary account's orders, complete with sold_price,
 * unit_cost and roi, because it had authorized the same seller account and
 * taken the row. The original owner's only symptom was that their sync
 * "interfered" until they stopped using the other login.
 *
 * WHY A GUARD RATHER THAN A CONSTRAINT CHANGE
 * -------------------------------------------
 * Widening to UNIQUE(user_id, seller_id, marketplace_id) would ALLOW two users
 * to hold the same seller concurrently -- two sync loops against one Amazon
 * quota, both writing the same orders under different user_ids. That is worse
 * than the bug. Refusing the second claim is the behaviour we actually want,
 * so the constraint stays and the write path checks ownership.
 *
 * DELIBERATE LIMIT: 'unknown' seller ids are not guarded
 * -----------------------------------------------------
 * Both call sites fall back to `sellingPartnerId || "unknown"`. If we guarded
 * that, the FIRST user to land an "unknown" row would block every later user
 * from connecting at all, because they would all collide on the same
 * ("unknown", marketplace) key. Blocking legitimate connections to defend a row
 * that identifies no one is the wrong trade. A missing selling-partner id is a
 * separate defect and belongs in its own fix.
 */

export interface OwnershipCheck {
  /** True when the caller may write this (seller_id, marketplace_id) row. */
  ok: boolean;
  /** Set only when ok is false: the user_id that currently holds the row. */
  heldBy?: string;
}

export interface OwnershipInput {
  userId: string;
  sellerId: string;
  marketplaceId: string;
}

/** Minimal shape of the supabase client this needs, so tests can fake it. */
export interface OwnershipQueryable {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): {
        eq(col: string, val: string): {
          maybeSingle(): Promise<{ data: { user_id?: string } | null; error?: unknown }>;
        };
      };
    };
  };
}

export async function checkSellerAuthorizationOwnership(
  supabase: OwnershipQueryable,
  { userId, sellerId, marketplaceId }: OwnershipInput,
): Promise<OwnershipCheck> {
  // See the header: an unidentified seller cannot be owned, and guarding it
  // would lock out everyone rather than protecting anyone.
  if (!sellerId || sellerId === 'unknown') return { ok: true };

  const { data } = await supabase
    .from('seller_authorizations')
    .select('user_id')
    .eq('seller_id', sellerId)
    .eq('marketplace_id', marketplaceId)
    .maybeSingle();

  const holder = data?.user_id;

  // No row yet, or the row is already ours: proceed. Re-authorizing your own
  // account must keep working -- it is how a user refreshes an expired token.
  if (!holder || holder === userId) return { ok: true };

  return { ok: false, heldBy: holder };
}

/** Response body for a refused claim. Shared so both paths say the same thing. */
export function ownershipConflictBody(marketplaceId: string) {
  return {
    error: 'seller_account_already_linked',
    marketplace_id: marketplaceId,
    message:
      'This Amazon seller account is already connected to a different account on this platform. ' +
      'Disconnect it there first, then try again.',
  };
}
