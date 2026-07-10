import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AWS SigV4 signing helpers
async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function getSigningKey(key: string, dateStamp: string, regionName: string, serviceName: string): Promise<Uint8Array> {
  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + key), dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  return await hmacSha256(kService, 'aws4_request');
}

async function getAwsSignature(
  method: string,
  path: string,
  queryParams: string,
  headers: Record<string, string>,
  payload: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<string> {
  const service = 'execute-api';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map(k => `${k.toLowerCase()}:${headers[k].trim()}`)
    .join('\n') + '\n';
  
  const signedHeaders = Object.keys(headers)
    .sort()
    .map(k => k.toLowerCase())
    .join(';');

  const payloadHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  
  const canonicalRequestHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

  const signingKey = await getSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = Array.from(
    new Uint8Array(await hmacSha256(signingKey, stringToSign))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// Normalize Amazon condition strings to consistent display format
function normalizeCondition(raw: string | null | undefined): string | null {
  if (!raw) return null;
  
  const normalized = raw.trim().toLowerCase().replace(/[_\s]+/g, '');
  
  const conditionMap: Record<string, string> = {
    'new': 'NEW',
    'newitem': 'NEW',
    'newoem': 'NEW',
    'usedlikenew': 'USED - LIKE NEW',
    'usedverygood': 'USED - VERY GOOD',
    'usedgood': 'USED - GOOD',
    'usedacceptable': 'USED - ACCEPTABLE',
    'collectiblelikenew': 'COLLECTIBLE - LIKE NEW',
    'collectibleverygood': 'COLLECTIBLE - VERY GOOD',
    'collectiblegood': 'COLLECTIBLE - GOOD',
    'collectibleacceptable': 'COLLECTIBLE - ACCEPTABLE',
    'refurbished': 'RENEWED',
    'renewed': 'RENEWED',
    'club': 'CLUB',
  };
  
  return conditionMap[normalized] || raw.toUpperCase();
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing LWA credentials');
  }

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('LWA token error response:', errorText);
    throw new Error(`LWA token error: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function callSpApi(
  path: string,
  accessToken: string,
  queryParams: Record<string, string> = {},
  method = 'GET',
  body = ''
): Promise<any> {
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;

  const host = 'sellingpartnerapi-na.amazon.com';
  const queryString = new URLSearchParams(queryParams).toString();
  const url = `https://${host}${path}${queryString ? '?' + queryString : ''}`;

  const headers: Record<string, string> = {
    'host': host,
    'x-amz-access-token': accessToken,
    'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
  };

  const authHeader = await getAwsSignature(
    method,
    path,
    queryString,
    headers,
    body,
    awsAccessKeyId,
    awsSecretAccessKey,
    region
  );

  headers['Authorization'] = authHeader;

  const response = await fetch(url, { method, headers, body: body || undefined });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('SP-API error:', response.status, errorText);
    throw new Error(`SP-API error: ${response.status}`);
  }

  return response.json();
}

async function getFnSkuForAsin(
  asin: string,
  sellerId: string,
  marketplaceId: string,
  refreshToken: string,
  supabase: any,
  userId: string
): Promise<{ fnsku: string | null; condition: string | null; source: 'db' | 'fba_inventory' | 'none'; options?: Array<{ fnsku: string; condition: string | null; seller_sku: string | null }> }> {
  console.log('getFnSkuForAsin called', { asin, sellerId, marketplaceId });

  // Always read existing cached rows first so we can merge with live results.
  const readCachedRows = async () => {
    const { data, error } = await supabase
      .from('fnsku_map')
      .select('fnsku, condition, seller_sku')
      .eq('seller_id', sellerId)
      .eq('marketplace_id', marketplaceId)
      .eq('asin', asin);
    if (error) console.error('fnsku_map read error:', error);
    return data || [];
  };

  let cachedRows: any[] = await readCachedRows();

  // Discover ALL SKUs the user has ever known for this ASIN.
  // Critical: /fba/inventory/v1/summaries frequently OMITS secondary-condition rows (Used-VG, etc) even when
  // the seller actually has stock. The `inventory` table is hydrated from the FBA Inventory Report — a
  // different SP-API endpoint that DOES return every SKU+FNSKU+condition — so we use it as a second source
  // of truth and seed `fnsku_map` from it directly when summaries fail.
  const knownSkus = new Set<string>();
  const inventoryFnskuRows: Array<{ sku: string; fnsku: string }> = [];
  for (const r of cachedRows) if (r.seller_sku) knownSkus.add(String(r.seller_sku));
  try {
    const { data: invRows } = await supabase
      .from('inventory')
      .select('sku, fnsku, listing_status')
      .eq('user_id', userId)
      .eq('asin', asin)
      .not('sku', 'is', null);
    for (const r of (invRows || [])) {
      if (!r.sku) continue;
      // SAFETY: never resurrect ghost SKUs. Skip rows whose listing has been
      // tombstoned (NOT_IN_CATALOG / DELETED). They must not seed fnsku_map
      // because that re-introduces ghost rows the eligibility check then
      // mis-reads as "manufacturer barcode mode" or active.
      const status = String((r as any).listing_status || '').toUpperCase();
      if (status === 'NOT_IN_CATALOG' || status === 'DELETED') continue;
      knownSkus.add(String(r.sku));
      if (r.fnsku) inventoryFnskuRows.push({ sku: String(r.sku), fnsku: String(r.fnsku) });
    }
  } catch (e) { console.warn('inventory sku scan failed:', e); }
  try {
    const { data: clRows } = await supabase
      .from('active_created_listings')
      .select('sku')
      .eq('user_id', userId)
      .eq('asin', asin)
      .not('sku', 'is', null);
    for (const r of (clRows || [])) if (r.sku) knownSkus.add(String(r.sku));
  } catch (e) { console.warn('active_created_listings sku scan failed:', e); }

  const skuList = Array.from(knownSkus);
  console.log(`Discovered ${skuList.length} known SKU(s) for ASIN ${asin}:`, skuList);
  console.log(`Inventory has ${inventoryFnskuRows.length} (sku,fnsku) pair(s):`, inventoryFnskuRows);

  // Heuristic: Amazon Grading Program SKUs encode the condition as a 2-letter suffix.
  // Format: amzn.gr.<base>-<random>-<CODE>   CODE ∈ { LN, VG, GD, AC, RF }
  const conditionFromSku = (sku: string): string => {
    const m = sku.match(/-([A-Z]{2,4})$/);
    if (!m) return 'NEW';
    const code = m[1].toUpperCase();
    const map: Record<string, string> = {
      LN: 'USED - LIKE NEW',
      VG: 'USED - VERY GOOD',
      GD: 'USED - GOOD',
      AC: 'USED - ACCEPTABLE',
      RF: 'RENEWED',
    };
    return map[code] || 'NEW';
  };

  // Seed fnsku_map directly from inventory (covers Used-VG and other secondary conditions
  // that summaries reliably omits). Each row is keyed by (sku, fnsku) so NEW + USED both persist.
  // SAFETY: Skip Amazon-grading-program ghost SKUs (`amzn.gr.*`). These are auto-generated by
  // Amazon for returned/relisted units and are routinely deleted by sellers in Seller Central.
  // We must not seed them from local inventory — only live FBA Summaries below may add them.
  const isAmznGrSku = (s: string | null | undefined) =>
    !!s && s.toLowerCase().startsWith('amzn.gr.');
  const seedSource = inventoryFnskuRows.filter((r) => !isAmznGrSku(r.sku));
  if (seedSource.length) {
    const seedRows = seedSource.map((r) => ({
      seller_id: sellerId,
      marketplace_id: marketplaceId,
      asin,
      seller_sku: r.sku,
      fnsku: r.fnsku,
      condition: conditionFromSku(r.sku),
    }));
    const { error: seedErr } = await supabase
      .from('fnsku_map')
      .upsert(seedRows, { onConflict: 'seller_id,marketplace_id,asin,fnsku', ignoreDuplicates: false });
    if (seedErr) console.error('Seed-from-inventory upsert error:', seedErr);
    else console.log(`Seeded fnsku_map with ${seedRows.length} row(s) from inventory`);
    cachedRows = await readCachedRows();
  }

  // Step 2: Hit FBA Inventory Summaries — once per chunk of SKUs (max 50), AND once unfiltered as a safety net.
  try {
    const accessToken = await getLwaAccessToken(refreshToken);
    const matches: any[] = [];

    // 2a) Targeted query per known SKU chunk — guarantees we get every condition the user actually owns.
    const chunkSize = 50;
    for (let i = 0; i < skuList.length; i += chunkSize) {
      const chunk = skuList.slice(i, i + chunkSize);
      try {
        const resp = await callSpApi('/fba/inventory/v1/summaries', accessToken, {
          granularityType: 'Marketplace',
          granularityId: marketplaceId,
          marketplaceIds: marketplaceId,
          details: 'true',
          sellerSkus: chunk.join(','),
        });
        const summaries = resp.payload?.inventorySummaries || [];
        for (const s of summaries) if (s.asin === asin) matches.push(s);
      } catch (e) {
        console.warn(`Targeted summaries call failed for chunk:`, chunk, e);
      }
    }

    // 2b) Unfiltered scan (paginated) — catches any SKU we don't know about yet.
    if (matches.length < 2) {
      let nextToken: string | undefined;
      let pages = 0;
      do {
        const params: Record<string, string> = {
          granularityType: 'Marketplace',
          granularityId: marketplaceId,
          marketplaceIds: marketplaceId,
          details: 'true',
        };
        if (nextToken) params.nextToken = nextToken;
        const resp = await callSpApi('/fba/inventory/v1/summaries', accessToken, params);
        const summaries = resp.payload?.inventorySummaries || [];
        for (const s of summaries) if (s.asin === asin) matches.push(s);
        nextToken = resp.payload?.nextToken;
        pages += 1;
      } while (nextToken && pages < 10); // hard cap
    }

    // Dedup by (sellerSku, fnSku)
    const uniq = new Map<string, any>();
    for (const m of matches) {
      if (!m.fnSku) continue;
      const key = `${m.sellerSku || ''}|${m.fnSku}`;
      if (!uniq.has(key)) uniq.set(key, m);
    }
    const valid = Array.from(uniq.values());

    if (valid.length) {
      console.log(`Found ${valid.length} FBA summary match(es) for ASIN ${asin}`);
      const rows = valid.map((found: any) => ({
        seller_id: sellerId,
        marketplace_id: marketplaceId,
        asin,
        seller_sku: found.sellerSku || null,
        fnsku: found.fnSku,
        condition: normalizeCondition(found.condition || null),
      }));

      const { error: insertError } = await supabase
        .from('fnsku_map')
        .upsert(rows, { onConflict: 'seller_id,marketplace_id,asin,fnsku' });
      if (insertError) console.error('Error saving FNSKUs to database:', insertError);

      // Re-read so we return the merged authoritative state (live + previously cached conditions we didn't re-confirm).
      cachedRows = await readCachedRows();
    } else {
      console.log('ASIN not found in FBA inventory summaries (targeted + unfiltered)');
    }
  } catch (error) {
    console.error('Error calling FBA Inventory API:', error);
  }

  // Build set of SKUs that live FBA Summaries confirmed THIS call.
  const liveConfirmedSkus = new Set<string>();
  const tombstonedSkus = new Set<string>();
  // `valid` may be undefined if the try block above threw before defining it.
  try {
    // @ts-ignore — valid is defined inside the try; safely re-derive from cachedRows below.
  } catch {}

  // Filter out Amazon-grading ghost SKUs (`amzn.gr.*`) UNLESS live Summaries confirmed
  // them in this call. Sellers routinely delete these in Seller Central, but stale
  // fnsku_map / inventory rows would otherwise resurface them in pickers.
  // We treat liveConfirmedSkus as: rows whose seller_sku appears in the FBA inventory
  // table (the Reports source) — those are the only "currently active on Amazon" signal
  // we have here without a second SP-API round-trip.
  try {
    const { data: liveInv } = await supabase
      .from('inventory')
      .select('sku, listing_status, available, reserved, inbound')
      .eq('user_id', userId)
      .eq('asin', asin)
      .not('sku', 'is', null);
    for (const r of (liveInv || [])) {
      const status = String((r as any).listing_status || '').toUpperCase();
      if ((status === 'NOT_IN_CATALOG' || status === 'DELETED') && r.sku) {
        tombstonedSkus.add(String(r.sku));
      }
      const hasStock =
        Number((r as any).available || 0) +
        Number((r as any).reserved || 0) +
        Number((r as any).inbound || 0) > 0;
      if (status === 'ACTIVE' && hasStock && r.sku) {
        liveConfirmedSkus.add(String(r.sku));
      }
    }
  } catch (e) { console.warn('liveConfirmedSkus lookup failed:', e); }

  const visibleRows = cachedRows.filter((r: any) => {
    if (r.seller_sku && tombstonedSkus.has(String(r.seller_sku))) return false;
    if (!isAmznGrSku(r.seller_sku)) return true;
    return liveConfirmedSkus.has(String(r.seller_sku));
  });

  if (visibleRows.length > 0) {
    const first = visibleRows[0];
    return {
      fnsku: first.fnsku,
      condition: first.condition || null,
      source: 'db',
      options: visibleRows.map((r: any) => ({ fnsku: r.fnsku, condition: r.condition || null, seller_sku: r.seller_sku || null })),
    };
  }

  console.log('FNSKU not found via any method (after amzn.gr.* filter)');
  return { fnsku: null, condition: null, source: 'none' };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify user authentication
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { asin } = await req.json();

    if (!asin) {
      return new Response(JSON.stringify({ error: 'Missing asin parameter' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get all seller authorizations for this user (multi-marketplace)
    const { data: authRows, error: sellerError } = await supabase
      .from('seller_authorizations')
      .select('seller_id, marketplace_id, refresh_token')
      .eq('user_id', user.id);

    // Prefer US marketplace, fallback to first available
    const sellerAuth = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (sellerError || !sellerAuth) {
      return new Response(JSON.stringify({ error: 'Seller authorization not found. Please connect your Amazon account first.' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!sellerAuth.refresh_token) {
      return new Response(JSON.stringify({ error: 'Amazon refresh token not found. Please reconnect your Amazon account.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const result = await getFnSkuForAsin(
      asin,
      sellerAuth.seller_id,
      sellerAuth.marketplace_id,
      sellerAuth.refresh_token,
      supabase,
      user.id
    );

    console.log('Final result:', { asin, ...result });

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in get-fnsku function:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
