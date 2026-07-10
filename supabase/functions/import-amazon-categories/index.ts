import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const DOMAIN_MAP: Record<string, number> = {
  US: 1, UK: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

// Known Amazon US root category IDs for seeding
const US_ROOT_CATEGORIES: Record<string, number> = {
  "Arts, Crafts & Sewing": 2617941011,
  "Automotive": 15684181,
  "Baby Products": 165796011,
  "Beauty & Personal Care": 3760911,
  "Books": 283155,
  "CDs & Vinyl": 5174,
  "Cell Phones & Accessories": 2335752011,
  "Clothing, Shoes & Jewelry": 7141123011,
  "Collectibles & Fine Art": 4991425011,
  "Computers & Accessories": 541966,
  "Digital Music": 624868011,
  "Electronics": 172282,
  "Garden & Outdoor": 2972638011,
  "Grocery & Gourmet Food": 16310101,
  "Handmade Products": 11260432011,
  "Health & Household": 3760901,
  "Home & Kitchen": 1055398,
  "Industrial & Scientific": 16310091,
  "Kindle Store": 133140011,
  "Kitchen & Dining": 284507,
  "Movies & TV": 2625373011,
  "Musical Instruments": 11091801,
  "Office Products": 1064954,
  "Pet Supplies": 2619533011,
  "Software": 229534,
  "Sports & Outdoors": 3375251,
  "Tools & Home Improvement": 228013,
  "Toys & Games": 165793011,
  "Video Games": 468642,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get('KEEPA_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'KEEPA_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Auth check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const token = authHeader.replace('Bearer ', '');
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json();
    const { action = 'search', marketplace = 'US', searchTerm, categoryId, parentId } = body;
    const domainId = DOMAIN_MAP[marketplace] ?? 1;

    // ACTION: seed — insert known root categories without Keepa call
    if (action === 'seed') {
      console.log(`[CategoryImport] Seeding root categories for ${marketplace}`);
      const roots = marketplace === 'US' ? US_ROOT_CATEGORIES : {};
      
      if (Object.keys(roots).length === 0) {
        return new Response(JSON.stringify({ error: 'Seed data only available for US marketplace currently' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const rows = Object.entries(roots).map(([name, id]) => ({
        id,
        marketplace,
        name,
        is_root: true,
        depth: 0,
        path: name,
        children_count: 0,
      }));

      const { error: upsertErr } = await supabase
        .from('amazon_categories')
        .upsert(rows, { onConflict: 'id' });

      if (upsertErr) {
        console.error('[CategoryImport] Seed error:', upsertErr);
        return new Response(JSON.stringify({ error: upsertErr.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ seeded: rows.length, marketplace }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ACTION: search — search Keepa for categories by term
    if (action === 'search') {
      if (!searchTerm || searchTerm.length < 2) {
        return new Response(JSON.stringify({ error: 'searchTerm must be at least 2 characters' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`[CategoryImport] Searching categories: "${searchTerm}" in ${marketplace}`);

      const keepaUrl = `https://api.keepa.com/search?key=${apiKey}&domain=${domainId}&type=category&term=${encodeURIComponent(searchTerm)}`;
      const res = await fetch(keepaUrl);

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[CategoryImport] Keepa error ${res.status}: ${errText}`);

        if (res.status === 429) {
          let retryAfterMs: number | null = null;
          try {
            const parsed = JSON.parse(errText);
            retryAfterMs = Number(parsed?.refillIn ?? 0) || null;
          } catch { }

          return new Response(JSON.stringify({
            error: 'Keepa rate limited',
            code: 'KEEPA_RATE_LIMIT',
            retryAfterMs,
          }), {
            status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ error: `Keepa API error: ${res.status}` }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const keepaData = await res.json();
      // Keepa returns { categories: { [catId]: { name, parent, ... } } }
      const categories = keepaData.categories || {};
      const catEntries = Object.entries(categories);

      console.log(`[CategoryImport] Found ${catEntries.length} categories for "${searchTerm}"`);

      if (catEntries.length === 0) {
        return new Response(JSON.stringify({ categories: [], saved: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Save to DB
      const rows = catEntries.map(([idStr, cat]: [string, any]) => ({
        id: Number(idStr),
        marketplace,
        name: cat.name || 'Unknown',
        context_free_name: cat.contextFreeName || null,
        parent_id: cat.parent && cat.parent > 0 ? cat.parent : null,
        is_root: !cat.parent || cat.parent <= 0,
        depth: cat.highestRank != null ? 0 : (cat.parent ? 1 : 0),
        path: cat.name || 'Unknown',
        children_count: cat.children?.length || 0,
        product_count: cat.productCount || 0,
      }));

      // Upsert in batches of 200
      let saved = 0;
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        // Remove parent_id temporarily to avoid FK constraint issues on insert
        const batchNoParent = batch.map(r => ({ ...r, parent_id: null }));
        const { error: upsertErr } = await supabase
          .from('amazon_categories')
          .upsert(batchNoParent, { onConflict: 'id' });
        if (!upsertErr) saved += batch.length;
        else console.warn(`[CategoryImport] Batch upsert warning:`, upsertErr.message);
      }

      // Now update parent_ids
      for (const row of rows) {
        if (row.parent_id) {
          await supabase
            .from('amazon_categories')
            .update({ parent_id: row.parent_id })
            .eq('id', row.id);
        }
      }

      // Return the categories for UI
      const result = rows.map(r => ({
        id: r.id,
        name: r.name,
        contextFreeName: r.context_free_name,
        parentId: r.parent_id,
        isRoot: r.is_root,
        childrenCount: r.children_count,
        productCount: r.product_count,
      }));

      return new Response(JSON.stringify({ categories: result, saved, tokensLeft: keepaData.tokensLeft ?? null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ACTION: children — get children of a category from Keepa
    if (action === 'children') {
      if (!categoryId) {
        return new Response(JSON.stringify({ error: 'categoryId required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`[CategoryImport] Looking up category ${categoryId} in ${marketplace}`);

      const keepaUrl = `https://api.keepa.com/category?key=${apiKey}&domain=${domainId}&category=${categoryId}&parents=1`;
      const res = await fetch(keepaUrl);

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 429) {
          let retryAfterMs: number | null = null;
          try { retryAfterMs = Number(JSON.parse(errText)?.refillIn ?? 0) || null; } catch { }
          return new Response(JSON.stringify({ error: 'Keepa rate limited', code: 'KEEPA_RATE_LIMIT', retryAfterMs }), {
            status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: `Keepa error: ${res.status}` }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const keepaData = await res.json();
      const categories = keepaData.categories || {};
      const catEntries = Object.entries(categories);

      // Save all returned categories
      const rows = catEntries.map(([idStr, cat]: [string, any]) => ({
        id: Number(idStr),
        marketplace,
        name: cat.name || 'Unknown',
        context_free_name: cat.contextFreeName || null,
        parent_id: cat.parent && cat.parent > 0 ? cat.parent : null,
        is_root: !cat.parent || cat.parent <= 0,
        depth: 0,
        path: cat.name || 'Unknown',
        children_count: cat.children?.length || 0,
        product_count: cat.productCount || 0,
      }));

      let saved = 0;
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        const batchNoParent = batch.map(r => ({ ...r, parent_id: null }));
        const { error } = await supabase.from('amazon_categories').upsert(batchNoParent, { onConflict: 'id' });
        if (!error) saved += batch.length;
      }
      for (const row of rows) {
        if (row.parent_id) {
          await supabase.from('amazon_categories').update({ parent_id: row.parent_id }).eq('id', row.id);
        }
      }

      const result = rows.map(r => ({
        id: r.id, name: r.name, parentId: r.parent_id, isRoot: r.is_root,
        childrenCount: r.children_count, productCount: r.product_count,
      }));

      return new Response(JSON.stringify({ categories: result, saved, tokensLeft: keepaData.tokensLeft ?? null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ACTION: list — list categories from Supabase (no Keepa call)
    if (action === 'list') {
      let query = supabase
        .from('amazon_categories')
        .select('id, name, context_free_name, parent_id, is_root, depth, path, children_count, product_count')
        .eq('marketplace', marketplace)
        .eq('is_active', true)
        .order('name');

      if (parentId === null || parentId === 'root') {
        query = query.eq('is_root', true);
      } else if (parentId) {
        query = query.eq('parent_id', parentId);
      }

      const { data, error } = await query.limit(500);

      if (error) {
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ categories: data || [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[CategoryImport] Error:', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
