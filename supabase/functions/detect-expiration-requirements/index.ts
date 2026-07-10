import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const HIGH_CONFIDENCE_PRODUCT_TYPE_KEYWORDS = [
  'grocery',
  'food',
  'beverage',
  'drink',
  'health',
  'beauty',
  'supplement',
  'vitamin',
  'cosmetic',
  'skincare',
  'topical',
  'personal_care',
] as const

const EXPIRATION_ATTRIBUTE_KEYWORDS = [
  'shelf_life',
  'expiration',
  'expiry',
  'is_expiration_dated_product',
  'item_form',
] as const

const enc = new TextEncoder()

type DetectRequest = {
  items?: Array<{ asin: string; sku?: string }>
}

type DetectResponse = {
  asin: string
  sku?: string
  expirationRequired: boolean
  detectionReason: string | null
}

const tokenCache: Record<string, { token: string; expiresAt: number }> = {}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacSha256(key: string | ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const keyBytes = typeof key === 'string' ? enc.encode(key) : new Uint8Array(key)
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data))
}

async function getSigningKey(secret: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(`AWS4${secret}`, dateStamp)
  const kRegion = await hmacSha256(kDate, region)
  const kService = await hmacSha256(kRegion, service)
  return hmacSha256(kService, 'aws4_request')
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(data))
  return toHex(hash)
}

async function getLwaAccessToken(): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID') ?? Deno.env.get('SPAPI_LWA_CLIENT_ID')
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') ?? Deno.env.get('SPAPI_LWA_CLIENT_SECRET')
  const refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN')

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing SP-API LWA credentials')
  }

  const cacheKey = `NA-${refreshToken.slice(0, 10)}`
  const cached = tokenCache[cacheKey]
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  if (!response.ok) {
    throw new Error(`LWA token error: ${response.status} ${await response.text()}`)
  }

  const data = await response.json()
  tokenCache[cacheKey] = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 }
  return data.access_token
}

async function signRequest(method: string, url: string, accessToken: string, region: string) {
  const awsAccessKey = Deno.env.get('AWS_ACCESS_KEY_ID')
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')
  if (!awsAccessKey || !awsSecretKey) throw new Error('Missing AWS credentials')

  const parsed = new URL(url)
  const host = parsed.host
  const path = parsed.pathname
  const query = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const service = 'execute-api'
  const payloadHash = await sha256Hex('')
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-date'
  const canonicalRequest = `${method}\n${path}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const algorithm = 'AWS4-HMAC-SHA256'
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`
  const signingKey = await getSigningKey(awsSecretKey, dateStamp, region, service)
  const signature = toHex(await hmacSha256(signingKey, stringToSign))

  return {
    Authorization: `${algorithm} Credential=${awsAccessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-access-token': accessToken,
    'x-amz-date': amzDate,
  }
}

function detectFromCatalog(data: any): { expirationRequired: boolean; detectionReason: string | null } {
  const productType = String(data?.productTypes?.[0]?.productType || data?.summaries?.[0]?.productType || '').toLowerCase()
  const matchingProductType = HIGH_CONFIDENCE_PRODUCT_TYPE_KEYWORDS.find((keyword) => productType.includes(keyword))
  if (matchingProductType) {
    return {
      expirationRequired: true,
      detectionReason: `Detected: ${matchingProductType.replace(/_/g, ' ')} product type`,
    }
  }

  const attributes = data?.attributes && typeof data.attributes === 'object' ? data.attributes : {}
  const attributeKeys = Object.keys(attributes)
  const matchingAttribute = attributeKeys.find((key) =>
    EXPIRATION_ATTRIBUTE_KEYWORDS.some((keyword) => key.toLowerCase().includes(keyword)),
  )

  if (matchingAttribute) {
    return {
      expirationRequired: true,
      detectionReason: `Detected: ${matchingAttribute.replace(/_/g, ' ')}`,
    }
  }

  return { expirationRequired: false, detectionReason: null }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !anonKey) throw new Error('Supabase client configuration missing')

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: userData, error: userError } = await client.auth.getUser()
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = (await req.json()) as DetectRequest
    const items = Array.isArray(body.items) ? body.items.filter((item) => item?.asin) : []
    if (items.length === 0) {
      return new Response(JSON.stringify({ error: 'At least one ASIN is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const accessToken = await getLwaAccessToken()
    const marketplaceId = Deno.env.get('SPAPI_MARKETPLACE_ID')
    const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1'
    if (!marketplaceId) throw new Error('SPAPI_MARKETPLACE_ID is not configured')

    const results: DetectResponse[] = []

    for (const item of items.slice(0, 25)) {
      const url = `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${encodeURIComponent(item.asin)}?marketplaceIds=${marketplaceId}&includedData=summaries,productTypes,attributes`
      try {
        const headers = await signRequest('GET', url, accessToken, region)
        const response = await fetch(url, { method: 'GET', headers })
        if (!response.ok) {
          results.push({ asin: item.asin, sku: item.sku, expirationRequired: false, detectionReason: null })
          continue
        }

        const data = await response.json()
        const detection = detectFromCatalog(data)
        results.push({ asin: item.asin, sku: item.sku, ...detection })
      } catch {
        results.push({ asin: item.asin, sku: item.sku, expirationRequired: false, detectionReason: null })
      }
    }

    return new Response(JSON.stringify({ items: results }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    const message = error instanceof Error ? (error as Error).message : 'Unknown error'
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})