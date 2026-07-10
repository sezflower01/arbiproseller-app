// Sourcer — keyword/UPC/ASIN search via SP-API searchCatalogItems.
// Returns up to 10 matches with ASIN, title, brand, image.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MARKETPLACE_CONFIG: Record<string, { id: string; endpoint: string }> = {
  US: { id: 'ATVPDKIKX0DER', endpoint: 'sellingpartnerapi-na.amazon.com' },
  CA: { id: 'A2EUQ1WTGCTBG2', endpoint: 'sellingpartnerapi-na.amazon.com' },
  MX: { id: 'A1AM78C64UM0Y8', endpoint: 'sellingpartnerapi-na.amazon.com' },
  BR: { id: 'A2Q3Y263D00KWC', endpoint: 'sellingpartnerapi-na.amazon.com' },
};

async function getLWAAccessToken(): Promise<string> {
  // Use the same env set as calculate-roi (known working) to avoid mixing
  // a new LWA_CLIENT_ID with an old SPAPI_REFRESH_TOKEN.
  const clientId = Deno.env.get('SPAPI_LWA_CLIENT_ID') || Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('SPAPI_LWA_CLIENT_SECRET') || Deno.env.get('LWA_CLIENT_SECRET');
  const refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN') || Deno.env.get('LWA_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing SP-API credentials');
  }
  const resp = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    console.error('[sourcer-search] LWA token error', resp.status, errBody);
    throw new Error(`LWA token error ${resp.status}: ${errBody}`);
  }
  const data = await resp.json();
  return data.access_token;
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string,
): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname;
  const path = parsedUrl.pathname;
  // Build canonical query string (sorted)
  const params = Array.from(parsedUrl.searchParams.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const canonicalQuery = params
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join('&');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const encoder = new TextEncoder();
  const bodyHash = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  const payloadHash = Array.from(new Uint8Array(bodyHash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const canonicalRequest = `${method}\n${path}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${awsRegion}/execute-api/aws4_request`;
  const canonicalRequestHash = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(canonicalRequest),
  );
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHashHex}`;

  const hmac = async (
    key: ArrayBuffer | string,
    data: string,
  ): Promise<ArrayBuffer> => {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      typeof key === 'string' ? encoder.encode(key) : key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  };
  const kDate = await hmac(`AWS4${awsSecretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, awsRegion);
  const kService = await hmac(kRegion, 'execute-api');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = await hmac(kSigning, stringToSign);
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;
  return {
    Authorization: authorizationHeader,
    'x-amz-access-token': accessToken,
    'x-amz-date': amzDate,
    'Content-Type': 'application/json',
  };
}

interface SearchResultItem {
  asin: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const { query, marketplace = 'US' } = await req.json();
    const q = String(query || '').trim();
    if (!q) {
      return new Response(
        JSON.stringify({ success: false, error: 'Empty query' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const cfg = MARKETPLACE_CONFIG[marketplace] || MARKETPLACE_CONFIG.US;
    const token = await getLWAAccessToken();

    // Detect mode: ASIN (10 alphanumeric), UPC/EAN (digits only 8-14), else keywords.
    const isAsin = /^[A-Z0-9]{10}$/i.test(q);
    const isBarcode = /^\d{8,14}$/.test(q);

    let url: string;
    if (isAsin) {
      url = `https://${cfg.endpoint}/catalog/2022-04-01/items/${q.toUpperCase()}?marketplaceIds=${cfg.id}&includedData=summaries,images`;
    } else if (isBarcode) {
      url = `https://${cfg.endpoint}/catalog/2022-04-01/items?identifiers=${q}&identifiersType=UPC&marketplaceIds=${cfg.id}&includedData=summaries,images&pageSize=10`;
    } else {
      url = `https://${cfg.endpoint}/catalog/2022-04-01/items?keywords=${encodeURIComponent(q)}&marketplaceIds=${cfg.id}&includedData=summaries,images&pageSize=10`;
    }

    const headers = await signRequest('GET', url, '', token);
    const resp = await fetch(url, { method: 'GET', headers });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[sourcer-search] SP-API error', resp.status, errText);
      return new Response(
        JSON.stringify({
          success: false,
          error: `SP-API error ${resp.status}`,
          detail: errText.slice(0, 500),
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const data = await resp.json();

    const rawItems: any[] = isAsin ? [data] : data.items || [];
    const items: SearchResultItem[] = rawItems
      .filter((it) => it && (it.asin || it.ASIN))
      .map((it) => {
        const summary = it.summaries?.[0] || {};
        const image =
          it.images?.[0]?.images?.[0]?.link ||
          it.images?.[0]?.images?.find((i: any) => i.height >= 100)?.link ||
          null;
        return {
          asin: it.asin || it.ASIN,
          title: summary.itemName || summary.title || '(no title)',
          brand: summary.brand || summary.brandName || null,
          imageUrl: image,
        } as SearchResultItem;
      });

    return new Response(
      JSON.stringify({ success: true, mode: isAsin ? 'asin' : isBarcode ? 'upc' : 'keyword', items }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    console.error('[sourcer-search] error', err);
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
