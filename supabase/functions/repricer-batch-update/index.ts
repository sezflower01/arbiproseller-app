import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkMarketplaceAccess } from '../_shared/marketplace-guard.ts';
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Repricer Batch Update - Feed-based bulk price updates
 * 
 * Uses Amazon SP-API Feeds API (JSON_LISTINGS_FEED) to update 
 * prices for many SKUs in a single API call.
 * 
 * Flow:
 * 1. Receive array of price updates (SKU → newPrice, newMin, newMax)
 * 2. Build JSON_LISTINGS_FEED payload
 * 3. Create feed document (get presigned upload URL)
 * 4. Upload JSON payload to presigned URL
 * 5. Submit feed via Feeds API
 * 6. Store feed_id in repricer_feed_submissions for polling
 * 7. Background poll until DONE, parse result document
 * 8. Verify sample SKUs via GetListingsItem
 */

interface PriceUpdate {
  sku: string;
  asin: string;
  newPrice?: number;
  newMinPrice?: number;
  newMaxPrice?: number;
  oldPrice?: number;
  oldMinPrice?: number;
  oldMaxPrice?: number;
  assignmentId?: string;
  reason?: string;
  intelligenceFactors?: any;
}

interface BatchRequest {
  updates: PriceUpdate[];
  marketplace?: string;
  internal?: boolean;
  user_id?: string;
  mode?: 'submit' | 'poll';
  feedSubmissionId?: string;
}

// AWS SigV4 helpers
const hmacSha256 = async (key: ArrayBuffer | Uint8Array, data: Uint8Array): Promise<ArrayBuffer> => {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, data as any);
};

const sha256Hex = async (data: string): Promise<string> => {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
};

const getSignatureKey = async (key: string, dateStamp: string, region: string, service: string) => {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256(encoder.encode('AWS4' + key), encoder.encode(dateStamp));
  const kRegion = await hmacSha256(kDate, encoder.encode(region));
  const kService = await hmacSha256(kRegion, encoder.encode(service));
  return await hmacSha256(kService, encoder.encode('aws4_request'));
};

async function signedRequest(method: string, url: string, body: string, accessToken: string): Promise<Response> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const encoder = new TextEncoder();

  const urlObj = new URL(url);
  const host = urlObj.host;
  const path = urlObj.pathname;
  const queryString = urlObj.search.replace('?', '');
  const service = 'execute-api';
  
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  
  const payloadHashHex = await sha256Hex(body);
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;
  
  const canonicalRequestHashHex = await sha256Hex(canonicalRequest);
  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHashHex}`;
  
  const signingKey = await getSignatureKey(awsSecretAccessKey, date, awsRegion, service);
  const signature = await hmacSha256(signingKey, encoder.encode(stringToSign));
  const signatureHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;

  return fetch(url, {
    method,
    headers: {
      'Authorization': authorizationHeader,
      'x-amz-access-token': accessToken,
      'x-amz-date': timestamp,
      'host': host,
      'content-type': 'application/json',
    },
    body: method !== 'GET' ? body : undefined,
  });
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const lwaClientId = Deno.env.get('LWA_CLIENT_ID');
  const lwaClientSecret = Deno.env.get('LWA_CLIENT_SECRET');
  if (!lwaClientId || !lwaClientSecret) throw new Error('LWA credentials not configured');

  const resp = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: lwaClientId,
      client_secret: lwaClientSecret,
    }),
  });
  if (!resp.ok) throw new Error('Failed to get access token');
  const data = await resp.json();
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = requireInternalCall(req);
  if (__forbidden) return __forbidden;


  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: BatchRequest = await req.json();
    
    // Auth
    let userId: string;
    if (body.internal && body.user_id) {
      userId = body.user_id;
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) throw new Error('Unauthorized');
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) throw new Error('Unauthorized');
      userId = user.id;
    }

    const marketplace = body.marketplace || 'US';
    const mode = body.mode || 'submit';

    // SERVER-SIDE MARKETPLACE GUARD: Non-admins can only update their home marketplace
    if (!body.internal) {
      const guard = await checkMarketplaceAccess(supabase, userId, marketplace);
      if (!guard.allowed) {
        console.warn(`[MARKETPLACE_GUARD] ${guard.reason}`);
        return new Response(JSON.stringify({ success: false, error: guard.reason }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // MODULE ACCESS GUARD: repricer:run required (admin bypasses).
      const { checkModuleAccess } = await import('../_shared/module-access-guard.ts');
      const access = await checkModuleAccess(supabase, userId, 'repricer', 'run');
      if (!access.allowed) {
        console.warn(`[repricer-batch-update] BLOCKED user=${userId} reason=${access.reason}`);
        return new Response(JSON.stringify({ success: false, error: access.reason }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // ===================== POLL MODE =====================
    if (mode === 'poll' && body.feedSubmissionId) {
      return await pollFeedStatus(supabase, userId, body.feedSubmissionId);
    }

    // ===================== SUBMIT MODE =====================
    const updates = body.updates || [];
    if (updates.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'No updates provided' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Filter: only include SKUs with meaningful price change (≥ $0.01)
    const meaningfulUpdates = updates.filter(u => {
      if (u.newPrice !== undefined && u.oldPrice !== undefined) {
        return Math.abs(u.newPrice - u.oldPrice) >= 0.01;
      }
      return true;
    });

    if (meaningfulUpdates.length === 0) {
      console.log('[repricer-batch-update] All updates filtered out (no meaningful changes)');
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No meaningful price changes to submit',
        filtered: updates.length 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[repricer-batch-update] Submitting feed for ${meaningfulUpdates.length} SKUs (filtered ${updates.length - meaningfulUpdates.length})`);

    // Cap at 5,000 SKUs per feed
    const MAX_SKUS_PER_FEED = 5000;
    const updateChunks: PriceUpdate[][] = [];
    for (let i = 0; i < meaningfulUpdates.length; i += MAX_SKUS_PER_FEED) {
      updateChunks.push(meaningfulUpdates.slice(i, i + MAX_SKUS_PER_FEED));
    }
    
    if (updateChunks.length > 1) {
      console.log(`[repricer-batch-update] Splitting into ${updateChunks.length} feeds (max ${MAX_SKUS_PER_FEED} per feed)`);
    }

    // Get seller auth
    const marketplaceIdMap: Record<string, string> = {
      US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2',
      MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC',
    };
    const marketplaceId = marketplaceIdMap[marketplace] || 'ATVPDKIKX0DER';
    
    const { data: authRows } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', userId);
    
    const sellerAuth = authRows?.find(a => a.marketplace_id === marketplaceId) ||
                       authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') ||
                       authRows?.[0];
    if (!sellerAuth) throw new Error('Amazon seller account not connected');

    const accessToken = await getAccessToken(sellerAuth.refresh_token);

    const currencyMap: Record<string, string> = {
      'ATVPDKIKX0DER': 'USD', 'A2EUQ1WTGCTBG2': 'CAD',
      'A1AM78C64UM0Y8': 'MXN', 'A2Q3Y263D00KWC': 'BRL',
    };
    const currency = currencyMap[sellerAuth.marketplace_id] || 'USD';

    const allFeedResults: any[] = [];
    
    for (let chunkIdx = 0; chunkIdx < updateChunks.length; chunkIdx++) {
      const chunk = updateChunks[chunkIdx];
      console.log(`[repricer-batch-update] Processing chunk ${chunkIdx + 1}/${updateChunks.length} (${chunk.length} SKUs)`);

      // Build JSON_LISTINGS_FEED payload
      const messages = chunk.map((u, idx) => {
        const purchasableOffer: any = {
          marketplace_id: sellerAuth.marketplace_id,
          currency: currency,
        };

        if (u.newPrice !== undefined) {
          purchasableOffer.our_price = [{ schedule: [{ value_with_tax: u.newPrice }] }];
        }
        if (u.newMinPrice !== undefined) {
          purchasableOffer.minimum_seller_allowed_price = [{ schedule: [{ value_with_tax: u.newMinPrice }] }];
        }
        if (u.newMaxPrice !== undefined) {
          purchasableOffer.maximum_seller_allowed_price = [{ schedule: [{ value_with_tax: u.newMaxPrice }] }];
        }

        return {
          messageId: idx + 1,
          sku: u.sku,
          operationType: 'PARTIAL_UPDATE',
          productType: 'PRODUCT',
          attributes: {
            purchasable_offer: [purchasableOffer],
          },
        };
      });

      const feedPayload = {
        header: {
          sellerId: sellerAuth.seller_id,
          version: '2.0',
          issueLocale: 'en_US',
        },
        messages,
      };

      const feedPayloadStr = JSON.stringify(feedPayload);
      console.log(`[repricer-batch-update] Feed payload size: ${feedPayloadStr.length} bytes, ${messages.length} messages`);

      // Step 1: Create Feed Document
      const createDocUrl = `https://sellingpartnerapi-na.amazon.com/feeds/2021-06-30/documents`;
      const createDocBody = JSON.stringify({
        contentType: 'application/json; charset=UTF-8',
      });

      const createDocResp = await signedRequest('POST', createDocUrl, createDocBody, accessToken);
      const createDocText = await createDocResp.text();
      
      if (!createDocResp.ok) {
        console.error('[repricer-batch-update] Create feed document failed:', createDocResp.status, createDocText);
        throw new Error(`Create feed document failed (${createDocResp.status}): ${createDocText}`);
      }
      
      const feedDoc = JSON.parse(createDocText);
      const feedDocumentId = feedDoc.feedDocumentId;
      const uploadUrl = feedDoc.url;
      console.log(`[repricer-batch-update] Feed document created: ${feedDocumentId}`);

      // Step 2: Upload feed payload to presigned URL
      const uploadResp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: feedPayloadStr,
      });

      if (!uploadResp.ok) {
        const uploadErr = await uploadResp.text();
        console.error('[repricer-batch-update] Upload failed:', uploadResp.status, uploadErr);
        throw new Error(`Feed upload failed (${uploadResp.status})`);
      }
      console.log('[repricer-batch-update] Feed payload uploaded successfully');

      // Step 3: Submit feed (with retry for 429 QuotaExceeded)
      const submitUrl = `https://sellingpartnerapi-na.amazon.com/feeds/2021-06-30/feeds`;
      const submitBody = JSON.stringify({
        feedType: 'JSON_LISTINGS_FEED',
        marketplaceIds: [sellerAuth.marketplace_id],
        inputFeedDocumentId: feedDocumentId,
      });

      let submitResp: Response | null = null;
      let submitText = '';
      const FEED_SUBMIT_MAX_RETRIES = 3;
      for (let attempt = 0; attempt <= FEED_SUBMIT_MAX_RETRIES; attempt++) {
        submitResp = await signedRequest('POST', submitUrl, submitBody, accessToken);
        submitText = await submitResp.text();
        
        if (submitResp.ok) break;
        
        if (submitResp.status === 429 && attempt < FEED_SUBMIT_MAX_RETRIES) {
          const delayMs = (attempt + 1) * 5000; // 5s, 10s, 15s
          console.warn(`[repricer-batch-update] Feed submit 429, retry ${attempt + 1}/${FEED_SUBMIT_MAX_RETRIES} in ${delayMs}ms`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        
        console.error('[repricer-batch-update] Submit feed failed:', submitResp.status, submitText);
        throw new Error(`Submit feed failed (${submitResp.status}): ${submitText}`);
      }
      
      if (!submitResp || !submitResp.ok) {
        throw new Error(`Submit feed failed after ${FEED_SUBMIT_MAX_RETRIES} retries`);
      }

      const submitData = JSON.parse(submitText);
      const feedId = submitData.feedId;
      console.log(`[repricer-batch-update] Feed submitted: ${feedId}`);

      // Step 4: Store in repricer_feed_submissions
      // FIX: Use upsert pattern and verify we get the ID back
      const submissionRecord = {
        user_id: userId,
        feed_document_id: feedDocumentId,
        feed_id: feedId,
        marketplace,
        status: 'IN_QUEUE',
        sku_count: chunk.length,
        feed_payload: { skus: chunk.map(u => ({ sku: u.sku, asin: u.asin, newPrice: u.newPrice })) },
      };

      const { data: submission, error: insertError } = await supabase
        .from('repricer_feed_submissions')
        .insert(submissionRecord)
        .select('id')
        .single();

      if (insertError) {
        console.error('[repricer-batch-update] DB insert error:', insertError);
      }

      const submissionId = submission?.id;
      console.log(`[repricer-batch-update] Submission record created: id=${submissionId}, feed_id=${feedId}`);

      if (!submissionId) {
        console.error('[repricer-batch-update] CRITICAL: submissionId is null! DB insert may have failed. Will use feed_id for fallback updates.');
      }

      // Step 5: Log individual price actions with update_method = 'FEED'
      const actionRecords = chunk.map(u => ({
        user_id: userId,
        assignment_id: u.assignmentId || null,
        asin: u.asin,
        sku: u.sku,
        marketplace,
        old_price: u.oldPrice,
        new_price: u.newPrice,
        old_min_price: u.oldMinPrice,
        new_min_price: u.newMinPrice,
        old_max_price: u.oldMaxPrice,
        new_max_price: u.newMaxPrice,
        action_type: u.newMinPrice || u.newMaxPrice ? 'price_and_minmax_change' : 'price_change',
        trigger_source: 'scheduler',
        reason: u.reason || 'Batch feed update',
        intelligence_factors: u.intelligenceFactors || null,
        success: true, // Will be updated on feed failure
        update_method: 'FEED',
        feed_id: feedId,
        reconciliation_status: 'pending',
        intended_price: u.newPrice,
      }));

      if (actionRecords.length > 0) {
        const { error: actionsError } = await supabase
          .from('repricer_price_actions')
          .insert(actionRecords);
        if (actionsError) {
          console.error('[repricer-batch-update] Actions insert error:', actionsError);
        }
      }

      // Step 6: Background polling with robust error handling
      // Pass feed_id as fallback identifier in case submissionId is null
      (globalThis as any).EdgeRuntime?.waitUntil(
        pollAfterDelay(supabase, userId, submissionId, feedId, accessToken, sellerAuth.refresh_token, sellerAuth.marketplace_id, chunk)
      );

      allFeedResults.push({
        feedId,
        feedDocumentId,
        submissionId,
        skuCount: chunk.length,
      });
    } // end chunk loop

    return new Response(JSON.stringify({
      success: true,
      feedId: allFeedResults[0]?.feedId,
      feedDocumentId: allFeedResults[0]?.feedDocumentId,
      submissionId: allFeedResults[0]?.submissionId,
      skuCount: meaningfulUpdates.length,
      filtered: updates.length - meaningfulUpdates.length,
      feeds: allFeedResults.length > 1 ? allFeedResults : undefined,
      feedCount: allFeedResults.length,
      message: allFeedResults.length > 1
        ? `${allFeedResults.length} feeds submitted for ${meaningfulUpdates.length} SKUs (max ${MAX_SKUS_PER_FEED}/feed). Updates will apply in 1-5 minutes.`
        : `Feed submitted for ${meaningfulUpdates.length} SKUs. Updates will apply in 1-5 minutes.`,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[repricer-batch-update] Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: (error as Error).message || 'Batch update failed' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// Helper: update submission by ID or feed_id fallback
async function updateSubmission(
  supabase: any, submissionId: string | null, feedId: string, userId: string, updateData: any
) {
  if (submissionId) {
    const { error } = await supabase
      .from('repricer_feed_submissions')
      .update(updateData)
      .eq('id', submissionId);
    if (error) {
      console.error(`[repricer-batch-update] DB update by ID failed (id=${submissionId}):`, error);
      // Fallback to feed_id
      const { error: fallbackError } = await supabase
        .from('repricer_feed_submissions')
        .update(updateData)
        .eq('feed_id', feedId)
        .eq('user_id', userId);
      if (fallbackError) {
        console.error(`[repricer-batch-update] DB update by feed_id also failed:`, fallbackError);
      } else {
        console.log(`[repricer-batch-update] DB update succeeded via feed_id fallback`);
      }
    } else {
      console.log(`[repricer-batch-update] DB update succeeded for submission ${submissionId}`);
    }
  } else {
    // No submissionId - use feed_id directly
    console.log(`[repricer-batch-update] Using feed_id fallback for DB update (feed_id=${feedId})`);
    const { error } = await supabase
      .from('repricer_feed_submissions')
      .update(updateData)
      .eq('feed_id', feedId)
      .eq('user_id', userId);
    if (error) {
      console.error(`[repricer-batch-update] DB update by feed_id failed:`, error);
    } else {
      console.log(`[repricer-batch-update] DB update via feed_id succeeded`);
    }
  }
}

// Background: poll feed status after a delay
async function pollAfterDelay(
  supabase: any, userId: string, submissionId: string | null, feedId: string,
  accessToken: string, refreshToken: string, marketplaceId: string, originalUpdates: PriceUpdate[]
) {
  // Wait 2 minutes for Amazon to process
  await new Promise(r => setTimeout(r, 120_000));
  
  // Get fresh token
  let token = accessToken;
  try {
    token = await getAccessToken(refreshToken);
    console.log(`[repricer-batch-update] Refreshed access token for polling feed ${feedId}`);
  } catch (e) {
    console.warn('[repricer-batch-update] Token refresh failed in background, using original:', e);
  }
  
  // Poll up to 5 times with 60s intervals
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const feedUrl = `https://sellingpartnerapi-na.amazon.com/feeds/2021-06-30/feeds/${feedId}`;
      const resp = await signedRequest('GET', feedUrl, '', token);
      const respText = await resp.text();
      
      let data: any;
      try {
        data = JSON.parse(respText);
      } catch {
        console.error(`[repricer-batch-update] Poll ${attempt + 1}: non-JSON response:`, respText.slice(0, 500));
        await new Promise(r => setTimeout(r, 60_000));
        continue;
      }
      
      console.log(`[repricer-batch-update] Poll ${attempt + 1}: status=${data.processingStatus}, resultDocId=${data.resultFeedDocumentId || 'none'}`);
      
      if (data.processingStatus === 'DONE' || data.processingStatus === 'FATAL') {
        let feedResult: any = null;
        let skusSucceeded = 0;
        let skusFailed = 0;
        let failedSkuDetails: any[] = [];
        
        // Get result document if available
        if (data.resultFeedDocumentId) {
          try {
            const resultDocUrl = `https://sellingpartnerapi-na.amazon.com/feeds/2021-06-30/documents/${data.resultFeedDocumentId}`;
            const resultDocResp = await signedRequest('GET', resultDocUrl, '', token);
            const resultDocText = await resultDocResp.text();
            
            let resultDocData: any;
            try {
              resultDocData = JSON.parse(resultDocText);
            } catch {
              console.error('[repricer-batch-update] Result document metadata is not JSON:', resultDocText.slice(0, 500));
              resultDocData = null;
            }
            
            if (resultDocData?.url) {
              console.log(`[repricer-batch-update] Downloading result document from presigned URL...`);
              const isCompressed = resultDocData.compressionAlgorithm === 'GZIP';
              console.log(`[repricer-batch-update] Compression: ${resultDocData.compressionAlgorithm || 'none'}`);
              
              const resultResp = await fetch(resultDocData.url);
              let resultText: string;
              
              if (isCompressed) {
                // Decompress gzip response from Amazon
                try {
                  const compressedBuffer = await resultResp.arrayBuffer();
                  console.log(`[repricer-batch-update] Compressed result size: ${compressedBuffer.byteLength} bytes`);
                  const ds = new DecompressionStream('gzip');
                  const writer = ds.writable.getWriter();
                  writer.write(new Uint8Array(compressedBuffer));
                  writer.close();
                  const reader = ds.readable.getReader();
                  const chunks: Uint8Array[] = [];
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                  }
                  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
                  const merged = new Uint8Array(totalLength);
                  let offset = 0;
                  for (const c of chunks) {
                    merged.set(c, offset);
                    offset += c.length;
                  }
                  resultText = new TextDecoder().decode(merged);
                  console.log(`[repricer-batch-update] Decompressed result size: ${resultText.length} bytes`);
                } catch (decompErr) {
                  console.error('[repricer-batch-update] Gzip decompression failed:', decompErr);
                  resultText = await resultResp.text();
                }
              } else {
                resultText = await resultResp.text();
              }
              
              // Strip null bytes (\u0000) that break PostgreSQL text/jsonb storage
              resultText = resultText.replace(/\u0000/g, '');
              
              console.log(`[repricer-batch-update] Result document size: ${resultText.length} bytes`);
              console.log(`[repricer-batch-update] Result document (first 3000): ${resultText.slice(0, 3000)}`);
              
              try {
                feedResult = JSON.parse(resultText);
              } catch {
                console.warn('[repricer-batch-update] Result document is not JSON. Attempting line-by-line parsing...');
                // Amazon sometimes returns newline-delimited JSON (NDJSON)
                const lines = resultText.split('\n').filter(l => l.trim());
                const parsedLines: any[] = [];
                for (const line of lines) {
                  try { parsedLines.push(JSON.parse(line)); } catch { /* skip */ }
                }
                
                if (parsedLines.length > 0) {
                  console.log(`[repricer-batch-update] Parsed ${parsedLines.length} NDJSON lines`);
                  feedResult = { _ndjson: true, responses: parsedLines };
                } else {
                  console.warn('[repricer-batch-update] Not NDJSON either. Storing sanitized raw text for debugging.');
                  feedResult = { _rawText: resultText.slice(0, 5000), _format: 'unknown' };
                }
              }
              
              // Parse results - handle multiple Amazon response formats
              if (feedResult) {
                const parsed = parseFeedResult(feedResult);
                skusSucceeded = parsed.succeeded;
                skusFailed = parsed.failed;
                failedSkuDetails = parsed.failedDetails;
                console.log(`[repricer-batch-update] Parsed feed result: ${skusSucceeded} succeeded, ${skusFailed} failed`);
              }
            } else {
              console.warn('[repricer-batch-update] No download URL in result document metadata');
            }
          } catch (e) {
            console.error('[repricer-batch-update] Failed to fetch/parse result document:', e);
          }
        } else {
          console.warn('[repricer-batch-update] No resultFeedDocumentId in feed response');
          // DONE but no result doc — don't assume success, mark as DONE_NO_REPORT
          // Rely on SKU verification to confirm
          if (data.processingStatus === 'DONE') {
            console.log(`[repricer-batch-update] No result doc but DONE status — marking as DONE_NO_REPORT, will rely on SKU verification`);
          }
        }
        
        // Determine final status
        const noResultDoc = !data.resultFeedDocumentId;
        const finalStatus = data.processingStatus === 'FATAL' ? 'failed'
          : (noResultDoc && skusSucceeded === 0 && skusFailed === 0) ? 'DONE_NO_REPORT'
          : 'completed';

        // Update submission record
        // Sanitize feed_result for PostgreSQL storage (remove null bytes)
        const sanitizedFeedResult = feedResult 
          ? JSON.parse(JSON.stringify(feedResult).replace(/\u0000/g, ''))
          : null;

        const updateData = {
          status: finalStatus,
          skus_succeeded: skusSucceeded,
          skus_failed: skusFailed,
          feed_result: sanitizedFeedResult ? (failedSkuDetails.length > 0 
            ? { ...sanitizedFeedResult, _parsed_failures: failedSkuDetails.slice(0, 50) }
            : sanitizedFeedResult) : null,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        
        await updateSubmission(supabase, submissionId, feedId, userId, updateData);

        // If there were failures, update those price_actions
        if (skusFailed > 0 && failedSkuDetails.length > 0) {
          for (const failure of failedSkuDetails) {
            if (failure.sku) {
              const { error: updateErr } = await supabase
                .from('repricer_price_actions')
                .update({ 
                  success: false, 
                  error_message: failure.errorMessage || 'Feed processing error',
                  error_type: 'feed_rejection',
                })
                .eq('feed_id', feedId)
                .eq('sku', failure.sku)
                .eq('user_id', userId);
              if (updateErr) {
                console.error(`[repricer-batch-update] Failed to update action for SKU ${failure.sku}:`, updateErr);
              }
            }
          }
        }
        
        console.log(`[repricer-batch-update] Feed ${feedId} final: ${skusSucceeded} succeeded, ${skusFailed} failed`);
        
        // Step 7: Verify sample SKUs via GetListingsItem
        if (data.processingStatus === 'DONE' && originalUpdates.length > 0) {
          await verifySampleSkus(supabase, userId, feedId, token, marketplaceId, originalUpdates);
        }
        
        return;
      }
      
      if (data.processingStatus === 'IN_QUEUE' || data.processingStatus === 'IN_PROGRESS') {
        await updateSubmission(supabase, submissionId, feedId, userId, {
          status: data.processingStatus,
          updated_at: new Date().toISOString(),
        });
        await new Promise(r => setTimeout(r, 60_000));
        continue;
      }
      
      // Cancelled or unknown status
      await updateSubmission(supabase, submissionId, feedId, userId, {
        status: data.processingStatus || 'unknown',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_message: `Unexpected feed status: ${data.processingStatus}`,
      });
      return;
      
    } catch (e) {
      console.error(`[repricer-batch-update] Poll error (attempt ${attempt + 1}):`, e);
      if (attempt === 4) {
        await updateSubmission(supabase, submissionId, feedId, userId, {
          status: 'poll_timeout',
          error_message: 'Polling timed out after 5 attempts',
          updated_at: new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 60_000));
    }
  }
}

/**
 * Parse Amazon feed result document — handles multiple known formats:
 * 
 * Format 1 (JSON_LISTINGS_FEED): { responses: [{ status: "ACCEPTED"|"INVALID", sku, issues }] }
 * Format 2 (Processing Report): { summary: { messagesProcessed, messagesSuccessful, messagesWithError }, results: [...] }
 * Format 3 (Flat result): Array of result objects
 * Format 4 (No result doc but DONE): Means all succeeded
 */
function parseFeedResult(result: any): { succeeded: number; failed: number; failedDetails: any[] } {
  let succeeded = 0;
  let failed = 0;
  const failedDetails: any[] = [];

  // Format 1: responses array (most common for JSON_LISTINGS_FEED)
  if (result?.responses && Array.isArray(result.responses)) {
    for (const r of result.responses) {
      if (r.status === 'ACCEPTED') {
        succeeded++;
      } else {
        failed++;
        failedDetails.push({
          sku: r.sku,
          status: r.status,
          errorMessage: r.issues?.map((i: any) => i.message).join('; ') 
            || r.errors?.map((e: any) => (e as Error).message).join('; ')
            || `Status: ${r.status}`,
        });
      }
    }
    return { succeeded, failed, failedDetails };
  }

  // Format 2: summary + results (Processing Report)
  if (result?.summary) {
    succeeded = result.summary.messagesSuccessful || result.summary.messagesAccepted || 0;
    failed = result.summary.messagesWithError || result.summary.messagesInvalid || 0;
    
    if (result.results && Array.isArray(result.results)) {
      for (const r of result.results) {
        if (r.status !== 'ACCEPTED' && r.status !== 'SUCCESS') {
          failedDetails.push({
            sku: r.sku || r.messageId,
            status: r.status,
            errorMessage: r.errors?.map((e: any) => (e as Error).message || e.description).join('; ') || `Status: ${r.status}`,
          });
        }
      }
    }
    return { succeeded, failed, failedDetails };
  }

  // Format 3: Direct array
  if (Array.isArray(result)) {
    for (const r of result) {
      if (r.status === 'ACCEPTED' || r.status === 'SUCCESS') {
        succeeded++;
      } else {
        failed++;
        failedDetails.push({
          sku: r.sku,
          status: r.status,
          errorMessage: r.message || r.error || `Status: ${r.status}`,
        });
      }
    }
    return { succeeded, failed, failedDetails };
  }

  // Format 4: Single object with processingReport
  if (result?.processingReport) {
    const report = result.processingReport;
    succeeded = report.messagesSuccessful || 0;
    failed = report.messagesWithError || 0;
    return { succeeded, failed, failedDetails };
  }

  // Format 5: NDJSON (parsed into _ndjson wrapper by our pre-processor)
  if (result?._ndjson && Array.isArray(result.responses)) {
    for (const r of result.responses) {
      if (r.status === 'ACCEPTED' || r.status === 'SUCCESS') {
        succeeded++;
      } else {
        failed++;
        failedDetails.push({
          sku: r.sku,
          status: r.status,
          errorMessage: r.issues?.map((i: any) => i.message).join('; ')
            || r.errors?.map((e: any) => (e as Error).message).join('; ')
            || r.message || `Status: ${r.status}`,
        });
      }
    }
    return { succeeded, failed, failedDetails };
  }

  // Format 6: rawText (couldn't parse at all) — check for known patterns
  if (result?._rawText) {
    const raw = result._rawText as string;
    console.warn('[repricer-batch-update] Trying to extract counts from raw text...');
    // Check for "ACCEPTED" / "INVALID" occurrences
    const acceptedMatches = (raw.match(/ACCEPTED/gi) || []).length;
    const invalidMatches = (raw.match(/INVALID/gi) || []).length;
    const errorMatches = (raw.match(/ERROR/gi) || []).length;
    if (acceptedMatches > 0 || invalidMatches > 0 || errorMatches > 0) {
      succeeded = acceptedMatches;
      failed = invalidMatches + errorMatches;
      console.log(`[repricer-batch-update] Raw text extraction: ${succeeded} ACCEPTED, ${failed} INVALID/ERROR`);
      return { succeeded, failed, failedDetails };
    }
  }

  // Unknown format - log for debugging
  const safeStr = JSON.stringify(result || {}).replace(/\u0000/g, '');
  console.warn('[repricer-batch-update] Unknown feed result format. Keys:', Object.keys(result || {}));
  console.warn('[repricer-batch-update] Result sample:', safeStr.slice(0, 2000));
  
  return { succeeded: 0, failed: 0, failedDetails: [] };
}

/**
 * Verify sample SKUs: pick 3 (head, middle, tail) and check their
 * current price via GetListingsItem to confirm the feed actually applied.
 */
async function verifySampleSkus(
  supabase: any, userId: string, feedId: string, accessToken: string,
  marketplaceId: string, originalUpdates: PriceUpdate[]
) {
  try {
    // Wait 3 minutes before first verification — Amazon needs time to propagate
    console.log(`[repricer-batch-update] Waiting 3 minutes before verifying sample SKUs...`);
    await new Promise(r => setTimeout(r, 180_000));

    // Pick 3 sample SKUs: first, middle, last
    const sampleIndices = [
      0,
      Math.floor(originalUpdates.length / 2),
      originalUpdates.length - 1,
    ];
    const uniqueIndices = [...new Set(sampleIndices)];
    const samples = uniqueIndices.map(i => originalUpdates[i]).filter(Boolean);

    console.log(`[repricer-batch-update] Verifying ${samples.length} sample SKUs after feed ${feedId}`);

    const sellerId = await getSellerIdForUser(supabase, userId);
    if (!sellerId) {
      console.warn('[repricer-batch-update] Could not find seller_id for verification');
      return;
    }

    // Get fresh token for verification
    let verifyToken = accessToken;
    try {
      const refreshToken = await getRefreshTokenForUser(supabase, userId);
      if (refreshToken) verifyToken = await getAccessToken(refreshToken);
    } catch { /* use existing token */ }

    // First pass verification
    let verificationResults = await checkSkuPrices(samples, sellerId, marketplaceId, verifyToken);
    
    // Check for mismatches
    const mismatches = verificationResults.filter(v => v.match === false);
    
    if (mismatches.length > 0) {
      console.log(`[repricer-batch-update] ${mismatches.length} mismatches found, retrying in 3 minutes...`);
      await new Promise(r => setTimeout(r, 180_000));
      
      // Retry only mismatched SKUs
      const retryResults = await checkSkuPrices(
        mismatches.map(m => samples.find(s => s.sku === m.sku)!).filter(Boolean),
        sellerId, marketplaceId, verifyToken
      );
      
      // Merge retry results
      for (const retry of retryResults) {
        const idx = verificationResults.findIndex(v => v.sku === retry.sku);
        if (idx >= 0) {
          verificationResults[idx] = { ...retry, retried: true };
        }
      }
    }

    const verifiedCount = verificationResults.filter(v => v.verified).length;
    const totalChecked = verificationResults.length;
    console.log(`[repricer-batch-update] Verification complete: ${verifiedCount}/${totalChecked} SKUs confirmed on Amazon`);

    // Update feed submission with verification summary
    const verificationSummary = {
      checked_at: new Date().toISOString(),
      verified: verifiedCount,
      total: totalChecked,
      results: verificationResults,
    };

    // Read current feed_result then merge verification into it
    const { data: currentSub } = await supabase
      .from('repricer_feed_submissions')
      .select('feed_result, status')
      .eq('feed_id', feedId)
      .eq('user_id', userId)
      .single();

    const mergedResult = {
      ...(currentSub?.feed_result || {}),
      _verification: verificationSummary,
    };

    // If status was DONE_NO_REPORT and verification shows all matched, upgrade to completed
    const newStatus = currentSub?.status === 'DONE_NO_REPORT' && verifiedCount === totalChecked && totalChecked > 0
      ? 'completed'
      : currentSub?.status;

    await supabase
      .from('repricer_feed_submissions')
      .update({
        feed_result: mergedResult,
        status: newStatus,
        skus_succeeded: newStatus === 'completed' && (currentSub?.status === 'DONE_NO_REPORT')
          ? originalUpdates.length : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('feed_id', feedId)
      .eq('user_id', userId);

    // Store verification in price actions
    for (const vr of verificationResults) {
      if (vr.verified !== null) {
        await supabase
          .from('repricer_price_actions')
          .update({
            intelligence_factors: {
              verification: {
                checked_at: new Date().toISOString(),
                expected: vr.expectedPrice,
                actual: vr.actualPrice,
                confirmed: vr.verified,
              },
            },
          })
          .eq('feed_id', feedId)
          .eq('sku', vr.sku)
          .eq('user_id', userId);
      }
    }

  } catch (e) {
    console.error('[repricer-batch-update] Verification step failed:', e);
  }
}

// Check prices for a list of SKUs via GetListingsItem
async function checkSkuPrices(
  samples: PriceUpdate[], sellerId: string, marketplaceId: string, accessToken: string
): Promise<any[]> {
  const results: any[] = [];
  
  for (const sample of samples) {
    try {
      await new Promise(r => setTimeout(r, 1000)); // Rate limit spacing
      
      const listingsUrl = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sample.sku)}?marketplaceIds=${marketplaceId}&includedData=offers`;
      const resp = await signedRequest('GET', listingsUrl, '', accessToken);
      
      if (!resp.ok) {
        const errText = await resp.text();
        console.warn(`[repricer-batch-update] Verify SKU ${sample.sku} failed (${resp.status}): ${errText.slice(0, 200)}`);
        results.push({ sku: sample.sku, asin: sample.asin, expectedPrice: sample.newPrice, verified: false, error: `API ${resp.status}` });
        continue;
      }

      const listingData = await resp.json();
      
      // Extract current price from listing offers
      let actualPrice: number | null = null;
      if (listingData?.offers) {
        for (const offer of listingData.offers) {
          if (offer.marketplaceId === marketplaceId || !offer.marketplaceId) {
            actualPrice = offer.price?.amount 
              || offer.listingPrice?.amount 
              || offer.ourPrice?.[0]?.schedule?.[0]?.valueWithTax
              || null;
            break;
          }
        }
      }

      const priceMatch = actualPrice !== null && sample.newPrice !== undefined
        ? Math.abs(actualPrice - sample.newPrice) < 0.01
        : null;

      results.push({
        sku: sample.sku,
        asin: sample.asin,
        expectedPrice: sample.newPrice,
        actualPrice,
        verified: priceMatch === true,
        match: priceMatch,
      });

      console.log(`[repricer-batch-update] Verify SKU ${sample.sku}: expected=$${sample.newPrice}, actual=$${actualPrice}, match=${priceMatch}`);
    } catch (e) {
      console.error(`[repricer-batch-update] Verify SKU ${sample.sku} error:`, e);
      results.push({ sku: sample.sku, asin: sample.asin, expectedPrice: sample.newPrice, verified: false, error: String(e) });
    }
  }
  
  return results;
}

async function getRefreshTokenForUser(supabase: any, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('seller_authorizations')
    .select('refresh_token')
    .eq('user_id', userId)
    .limit(1);
  return data?.[0]?.refresh_token || null;
}

async function getSellerIdForUser(supabase: any, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('seller_authorizations')
    .select('seller_id')
    .eq('user_id', userId)
    .limit(1);
  return data?.[0]?.seller_id || null;
}

// Manual poll endpoint
async function pollFeedStatus(supabase: any, userId: string, feedSubmissionId: string) {
  const { data: submission, error } = await supabase
    .from('repricer_feed_submissions')
    .select('*')
    .eq('id', feedSubmissionId)
    .eq('user_id', userId)
    .single();

  if (error || !submission) {
    return new Response(JSON.stringify({ success: false, error: 'Submission not found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ 
    success: true, 
    submission 
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
