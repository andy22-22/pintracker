/**
 * PinScout — eBay Browse API Proxy
 * Service Worker syntax for Cloudflare dashboard editor.
 *
 * SETUP: After pasting this code, you MUST add two Environment Variables
 * in your Worker settings (Settings → Variables → Add variable):
 *
 *   EBAY_CLIENT_ID   →  your App ID,  e.g. AndrewWe-pintrack-PRD-28f6186d5-8fb89236
 *   EBAY_CLIENT_SECRET → your Cert ID, e.g. PRD-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *
 * The Worker will fetch a fresh OAuth token automatically and cache it for 90 minutes.
 */

// Simple in-memory token cache (lives for the lifetime of this Worker instance)
let cachedToken = null;
let tokenExpiry = 0;

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url    = new URL(request.url);
  const query  = url.searchParams.get('q');
  const filter = url.searchParams.get('filter') || 'sold'; // 'sold' or 'active'

  if (!query) {
    return corsJson({ error: 'Missing ?q= parameter' }, 400);
  }

  // Validate env vars are set
  if (!self.EBAY_CLIENT_ID || !self.EBAY_CLIENT_SECRET) {
    return corsJson({
      error: 'Worker env vars not set. Add EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in Worker Settings → Variables.'
    }, 500);
  }

  try {
    const token = await getToken();
    const data  = await searchEbay(token, query, filter);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    return corsJson({ error: err.message }, 502);
  }
}

// ── OAuth token (cached for 90 min) ──
async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;

  const credentials = btoa(`${self.EBAY_CLIENT_ID}:${self.EBAY_CLIENT_SECRET}`);
  const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OAuth token failed (${resp.status}): ${body.substring(0, 200)}`);
  }

  const json = await resp.json();
  cachedToken = json.access_token;
  tokenExpiry = now + (90 * 60 * 1000); // 90 minutes
  return cachedToken;
}

// ── Browse API search ──
async function searchEbay(token, query, filter) {
  // Build search term — always append "Disney pin" for relevance
  const searchTerm = query.toLowerCase().includes('disney') ? query : query + ' Disney pin';

  // For sold items we use the Marketplace Insights API (itemSales)
  // For active listings we use the Browse API (search)
  let apiUrl;
  if (filter === 'sold') {
    apiUrl = `https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search` +
      `?q=${encodeURIComponent(searchTerm)}` +
      `&category_ids=66522` +
      `&limit=30` +
      `&sort=endDate`;
  } else {
    apiUrl = `https://api.ebay.com/buy/browse/v1/item_summary/search` +
      `?q=${encodeURIComponent(searchTerm)}` +
      `&category_ids=66522` +
      `&limit=20` +
      `&sort=bestMatch`;
  }

  const resp = await fetch(apiUrl, {
    headers: {
      'Authorization':       `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'Content-Type':        'application/json'
    }
  });

  if (!resp.ok) {
    const body = await resp.text();
    // If marketplace insights not available, fall back to browse for active
    if (resp.status === 403 && filter === 'sold') {
      return { items: [], source: 'sold_unavailable', note: 'Sold data requires Marketplace Insights API access' };
    }
    throw new Error(`eBay ${filter} search failed (${resp.status}): ${body.substring(0, 300)}`);
  }

  const data = await resp.json();

  // Normalise response into consistent shape
  if (filter === 'sold') {
    const items = (data.itemSales || []).map(i => ({
      title:     i.title || '',
      price:     parseFloat(i.lastSoldPrice?.value || i.price?.value || 0),
      currency:  i.lastSoldPrice?.currency || 'USD',
      date:      i.lastSoldDate || '',
      url:       i.itemWebUrl || '',
      condition: i.condition || '',
      sold:      true
    })).filter(i => i.price > 0);
    return { items, total: data.total || items.length, source: 'marketplace_insights' };
  } else {
    const items = (data.itemSummaries || []).map(i => ({
      title:     i.title || '',
      price:     parseFloat(i.price?.value || 0),
      currency:  i.price?.currency || 'USD',
      date:      '',
      url:       i.itemWebUrl || '',
      condition: i.condition || '',
      sold:      false
    })).filter(i => i.price > 0);
    return { items, total: data.total || items.length, source: 'browse' };
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age':       '86400'
  };
}

function corsJson(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

