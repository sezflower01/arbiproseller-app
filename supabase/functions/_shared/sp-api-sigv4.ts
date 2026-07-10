// Shared SP-API SigV4 + LWA helpers (extracted for reuse across functions)

async function sha256(message: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message) as any);
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const kDate = await hmac(enc.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

export async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string,
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
    method, urlObj.pathname, urlObj.search.slice(1),
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm, amzDate, credentialScope, toHex(await sha256(canonicalRequest)),
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

export async function getLWAAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID')!;
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET')!;

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`LWA token error: ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

export function getSpApiEndpoint(marketplaceId?: string): string {
  // EU marketplaces
  const EU_IDS = new Set(['A1F83G8C2ARO7P','A1PA6795UKMFR9','A13V1IB3VIYZZH','APJ6JRA9NG5V4','A1RKKUPIHCS9HS','A1805IZSGTT6HS','A2NODRKZP88ZB9','A33AVAJ2PDY3EV','A17E79C6D8DWNP','A2VIGQ35RCS4UG']);
  // FE marketplaces
  const FE_IDS = new Set(['A1VC38T7YXB528','A39IBJ37TRP1C6','A19VAU5U5O7RUS']);
  if (marketplaceId && EU_IDS.has(marketplaceId)) return 'https://sellingpartnerapi-eu.amazon.com';
  if (marketplaceId && FE_IDS.has(marketplaceId)) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}
