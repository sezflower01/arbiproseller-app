import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AWS SigV4 signing utilities
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest('SHA-256', data as any);
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string
): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';

  const urlObj = new URL(url);
  const host = urlObj.host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = toHex(await sha256(body));

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    toHex(await sha256(canonicalRequest))
  ].join('\n');

  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Authorization': authHeader,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': host,
  };
}

async function getLWAAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID')!;
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET')!;

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
    throw new Error(`LWA token error: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

interface OrderItem {
  ASIN: string;
  SellerSKU: string;
  Title: string;
  QuantityOrdered: number;
  ItemPrice?: { Amount: string; CurrencyCode: string };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify JWT
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { orderIds, marketplaceId = 'ATVPDKIKX0DER' } = await req.json();
    console.log(`Processing ${orderIds?.length || 0} order IDs for marketplace ${marketplaceId}`);

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return new Response(JSON.stringify({ error: 'orderIds array required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get all seller authorizations for this user
    const { data: authRows, error: authFetchError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, seller_id, marketplace_id')
      .eq('user_id', user.id);

    // Find auth for target marketplace, fallback to any available
    const authRow = authRows?.find(a => a.marketplace_id === marketplaceId) || authRows?.[0];
    if (authFetchError || !authRow?.refresh_token) {
      console.error('[GET-ORDER-ITEMS] No seller authorization found for user:', user.id);
      return new Response(JSON.stringify({ error: 'Amazon account not connected' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Getting LWA access token...');
    const accessToken = await getLWAAccessToken(authRow.refresh_token);
    console.log('Got access token, processing orders...');
    
    const results: Record<string, { asin: string; sku: string; title: string; quantity: number; price: number }[]> = {};

    // Process orders with rate limiting (2 per second to stay within SP-API limits)
    for (let i = 0; i < orderIds.length; i++) {
      const orderId = orderIds[i];
      console.log(`Fetching order items for ${orderId} (${i + 1}/${orderIds.length})`);
      
      try {
        const url = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${orderId}/orderItems`;
        const headers = await signRequest('GET', url, '', accessToken);
        
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
        });

        if (response.status === 429) {
          // Rate limited, wait and retry
          await new Promise(r => setTimeout(r, 2000));
          const retryHeaders = await signRequest('GET', url, '', accessToken);
          const retryResponse = await fetch(url, {
            method: 'GET',
            headers: { ...retryHeaders, 'Content-Type': 'application/json' },
          });
          
          if (retryResponse.ok) {
            const data = await retryResponse.json();
            const items = (data.payload?.OrderItems || []) as OrderItem[];
            results[orderId] = items.map(item => ({
              asin: item.ASIN,
              sku: item.SellerSKU,
              title: item.Title || '',
              quantity: item.QuantityOrdered || 1,
              price: item.ItemPrice ? parseFloat(item.ItemPrice.Amount) : 0,
            }));
          }
        } else if (response.ok) {
          const data = await response.json();
          const items = (data.payload?.OrderItems || []) as OrderItem[];
          results[orderId] = items.map(item => ({
            asin: item.ASIN,
            sku: item.SellerSKU,
            title: item.Title || '',
            quantity: item.QuantityOrdered || 1,
            price: item.ItemPrice ? parseFloat(item.ItemPrice.Amount) : 0,
          }));
        } else {
          console.warn(`Failed to get items for order ${orderId}: ${response.status}`);
        }

        // Rate limit: 500ms between requests
        if (i < orderIds.length - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (err) {
        console.error(`Error fetching order ${orderId}:`, err);
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in get-order-items:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
