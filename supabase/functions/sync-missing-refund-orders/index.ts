import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// AWS Signature V4 helpers
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return await crypto.subtle.digest("SHA-256", encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", key as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

async function getSignatureKey(secret: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode("AWS4" + secret), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, "aws4_request");
}

async function signRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  payload: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  service: string
): Promise<Record<string, string>> {
  const urlObj = new URL(url);
  const host = urlObj.host;
  const path = urlObj.pathname;
  const queryString = urlObj.search.slice(1);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const signedHeaders = Object.keys(headers).map(k => k.toLowerCase()).sort().join(";");
  const canonicalHeaders = Object.entries(headers)
    .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`)
    .sort()
    .join("\n") + "\n";

  const payloadHash = toHex(await sha256(payload));
  const canonicalRequest = [method, path, queryString, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, toHex(await sha256(canonicalRequest))].join("\n");

  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...headers, "x-amz-date": amzDate, Authorization: authorization };
}

async function getLWAAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`LWA token error: ${res.status} ${errorText}`);
  }
  const data = await res.json();
  return data.access_token;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { order_ids } = body;

    if (!order_ids || !Array.isArray(order_ids) || order_ids.length === 0) {
      return new Response(JSON.stringify({ error: "order_ids array is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[SYNC_MISSING] User ${user.id} syncing ${order_ids.length} missing orders`);

    // Get seller authorization
    const { data: authData, error: authError } = await supabase
      .from("seller_authorizations")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (authError || !authData) {
      return new Response(JSON.stringify({ error: "No seller authorization found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const clientId = Deno.env.get("LWA_CLIENT_ID") || "";
    const clientSecret = Deno.env.get("LWA_CLIENT_SECRET") || "";
    const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID") || "";
    const secretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY") || "";

    const accessToken = await getLWAAccessToken(authData.refresh_token, clientId, clientSecret);
    console.log(`[SYNC_MISSING] Got LWA access token`);

    const region = "us-east-1";
    const host = "sellingpartnerapi-na.amazon.com";
    let syncedCount = 0;
    let errorCount = 0;
    const results: { orderId: string; success: boolean; asin?: string; error?: string }[] = [];

    // Process orders one by one (API rate limits)
    for (const orderId of order_ids.slice(0, 20)) { // Limit to 20 to avoid rate limits
      try {
        console.log(`[SYNC_MISSING] Fetching order items for: ${orderId}`);
        
        // Get order items to find ASIN
        const itemsPath = `/orders/v0/orders/${orderId}/orderItems`;
        const itemsUrl = `https://${host}${itemsPath}`;
        
        const itemsHeaders: Record<string, string> = {
          host,
          "x-amz-access-token": accessToken,
          "content-type": "application/json",
        };
        
        const signedItemsHeaders = await signRequest(
          "GET",
          itemsUrl,
          itemsHeaders,
          "",
          accessKeyId,
          secretAccessKey,
          region,
          "execute-api"
        );

        const itemsRes = await fetch(itemsUrl, {
          method: "GET",
          headers: signedItemsHeaders,
        });

        if (!itemsRes.ok) {
          const errText = await itemsRes.text();
          console.log(`[SYNC_MISSING] Failed to get items for ${orderId}: ${itemsRes.status} ${errText}`);
          results.push({ orderId, success: false, error: `API error: ${itemsRes.status}` });
          errorCount++;
          continue;
        }

        const itemsData = await itemsRes.json();
        const items = itemsData?.payload?.OrderItems || [];
        
        if (items.length === 0) {
          console.log(`[SYNC_MISSING] No items found for order ${orderId}`);
          results.push({ orderId, success: false, error: "No items in order" });
          errorCount++;
          continue;
        }

        // Get the first item's ASIN
        const firstItem = items[0];
        const asin = firstItem.ASIN;
        const sku = firstItem.SellerSKU;
        const title = firstItem.Title || '';
        const quantity = firstItem.QuantityOrdered || 1;
        
        console.log(`[SYNC_MISSING] Found ASIN ${asin} for order ${orderId}`);

        // Get product image from catalog API
        let imageUrl = '';
        try {
          const catalogPath = `/catalog/2022-04-01/items/${asin}?marketplaceIds=ATVPDKIKX0DER&includedData=images`;
          const catalogUrl = `https://${host}${catalogPath}`;
          
          const catalogHeaders: Record<string, string> = {
            host,
            "x-amz-access-token": accessToken,
            "content-type": "application/json",
          };
          
          const signedCatalogHeaders = await signRequest(
            "GET",
            catalogUrl,
            catalogHeaders,
            "",
            accessKeyId,
            secretAccessKey,
            region,
            "execute-api"
          );

          const catalogRes = await fetch(catalogUrl, {
            method: "GET",
            headers: signedCatalogHeaders,
          });

          if (catalogRes.ok) {
            const catalogData = await catalogRes.json();
            const images = catalogData?.images?.[0]?.images || [];
            if (images.length > 0) {
              imageUrl = images[0].link || '';
            }
          }
        } catch (e) {
          console.log(`[SYNC_MISSING] Failed to get image for ${asin}: ${e}`);
        }

        // Check if order already exists in sales_orders (check both exact match and with -REFUND suffix)
        const { data: existingOrders } = await supabase
          .from('sales_orders')
          .select('id, order_id, asin')
          .eq('user_id', user.id)
          .or(`order_id.eq.${orderId},order_id.like.${orderId}-REFUND%`);

        if (existingOrders && existingOrders.length > 0) {
          // Update all matching orders with correct ASIN if they have UNKNOWN
          for (const existingOrder of existingOrders) {
            if (existingOrder.asin === 'UNKNOWN' || existingOrder.asin === 'PENDING') {
              await supabase
                .from('sales_orders')
                .update({
                  asin,
                  sku,
                  title: existingOrder.order_id.includes('-REFUND') ? `[REFUND] ${title}` : title,
                  image_url: imageUrl,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', existingOrder.id);
              console.log(`[SYNC_MISSING] Updated existing order ${existingOrder.order_id} with ASIN ${asin}`);
            }
          }
          results.push({ orderId, success: true, asin });
          syncedCount++;
        } else {
          // Try to get order details to create a minimal record
          const orderPath = `/orders/v0/orders/${orderId}`;
          const orderUrl = `https://${host}${orderPath}`;
          
          const orderHeaders: Record<string, string> = {
            host,
            "x-amz-access-token": accessToken,
            "content-type": "application/json",
          };
          
          const signedOrderHeaders = await signRequest(
            "GET",
            orderUrl,
            orderHeaders,
            "",
            accessKeyId,
            secretAccessKey,
            region,
            "execute-api"
          );

          const orderRes = await fetch(orderUrl, {
            method: "GET",
            headers: signedOrderHeaders,
          });

          let orderDate = new Date().toISOString().split('T')[0];
          let soldPrice = 0;
          
          if (orderRes.ok) {
            const orderData = await orderRes.json();
            const order = orderData?.payload;
            if (order?.PurchaseDate) {
              orderDate = order.PurchaseDate.split('T')[0];
            }
            if (order?.OrderTotal?.Amount) {
              soldPrice = parseFloat(order.OrderTotal.Amount) || 0;
            }
          }

          // Insert the order
          const { error: insertError } = await supabase
            .from('sales_orders')
            .insert({
              user_id: user.id,
              order_id: orderId,
              asin,
              sku,
              title,
              image_url: imageUrl,
              quantity,
              sold_price: soldPrice / quantity,
              total_sale_amount: soldPrice,
              order_date: orderDate,
              status: 'historical',
              referral_fee: 0,
              fba_fee: 0,
              closing_fee: 0,
              total_fees: 0,
            });

          if (insertError) {
            console.log(`[SYNC_MISSING] Failed to insert order ${orderId}: ${insertError.message}`);
            results.push({ orderId, success: false, error: insertError.message });
            errorCount++;
          } else {
            console.log(`[SYNC_MISSING] Created new order record for ${orderId} with ASIN ${asin}`);
            results.push({ orderId, success: true, asin });
            syncedCount++;
          }
        }

        // Rate limit delay
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (e: any) {
        console.error(`[SYNC_MISSING] Error processing ${orderId}:`, e);
        results.push({ orderId, success: false, error: (e as Error).message });
        errorCount++;
      }
    }

    console.log(`[SYNC_MISSING] Complete: synced ${syncedCount}, errors ${errorCount}`);

    return new Response(JSON.stringify({
      success: true,
      synced: syncedCount,
      errors: errorCount,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("[SYNC_MISSING] Error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message || "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
