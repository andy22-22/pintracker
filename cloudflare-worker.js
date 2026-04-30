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
  const filter = url.searchParams.get('filter') || 'sold';

  if (!query) {
    return corsJson({ error: 'Missing ?q= parameter' }, 400);
  }

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

// ── OAuth token (cached 90 min) ──
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
  tokenExpiry = now + (90 * 60 * 1000);
  return cachedToken;
}

// ── Browse API search — searches globally across all eBay sites ──
async function searchEbay(token, query, filter) {
  const searchTerm = query.toLowerCase().includes('disney') ? query : query + ' Disney pin';

  // Search multiple marketplaces in parallel for global coverage
  const marketplaces = ['EBAY_US', 'EBAY_GB', 'EBAY_AU', 'EBAY_DE', 'EBAY_FR'];

  if (filter === 'sold') {
    // Marketplace Insights API — try each market, merge results
    const results = await Promise.allSettled(
      marketplaces.map(mkt => fetchSoldFromMarket(token, searchTerm, mkt))
    );
    let allItems = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allItems = allItems.concat(r.value);
    }
    // If Marketplace Insights unavailable everywhere, fall back to Browse
    if (allItems.length === 0) {
      return await searchBrowseFallback(token, searchTerm);
    }
    // Dedupe by URL, sort by date desc
    const seen = new Set();
    allItems = allItems.filter(i => { if (seen.has(i.url)) return false; seen.add(i.url); return true; });
    allItems.sort((a, b) => new Date(b.date||0) - new Date(a.date||0));
    return { items: allItems.slice(0, 100), total: allItems.length, source: 'marketplace_insights' };
  } else {
    // Browse API active listings — search US + GB, merge and dedupe
    const results = await Promise.allSettled(
      ['EBAY_US', 'EBAY_GB'].map(mkt => fetchActiveFromMarket(token, searchTerm, mkt))
    );
    let allItems = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allItems = allItems.concat(r.value);
    }
    const seen = new Set();
    allItems = allItems.filter(i => { if (seen.has(i.url)) return false; seen.add(i.url); return true; });
    return { items: allItems.slice(0, 40), total: allItems.length, source: 'browse' };
  }
}

async function fetchSoldFromMarket(token, searchTerm, marketplace) {
  const apiUrl = `https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search` +
    `?q=${encodeURIComponent(searchTerm)}&limit=100&sort=endDate`;

  const resp = await fetch(apiUrl, {
    headers: {
      'Authorization':           `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplace,
      'Content-Type':            'application/json'
    }
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.itemSales || []).map(i => ({
    title:       i.title || '',
    price:       parseFloat(i.lastSoldPrice?.value || i.price?.value || 0),
    currency:    i.lastSoldPrice?.currency || 'USD',
    pricingUsd:  convertToUsd(parseFloat(i.lastSoldPrice?.value || 0), i.lastSoldPrice?.currency || 'USD'),
    date:        i.lastSoldDate || '',
    url:         i.itemWebUrl || '',
    image:       i.image?.imageUrl || '',
    condition:   i.condition || '',
    marketplace: marketplace,
    sold:        true
  })).filter(i => i.price > 0);
}

async function fetchActiveFromMarket(token, searchTerm, marketplace) {
  const apiUrl = `https://api.ebay.com/buy/browse/v1/item_summary/search` +
    `?q=${encodeURIComponent(searchTerm)}&limit=30&sort=bestMatch`;

  const resp = await fetch(apiUrl, {
    headers: {
      'Authorization':           `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplace,
      'Content-Type':            'application/json'
    }
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.itemSummaries || []).map(i => ({
    title:       i.title || '',
    price:       parseFloat(i.price?.value || 0),
    currency:    i.price?.currency || 'USD',
    pricingUsd:  convertToUsd(parseFloat(i.price?.value || 0), i.price?.currency || 'USD'),
    date:        '',
    url:         i.itemWebUrl || '',
    image:       i.thumbnailImages?.[0]?.imageUrl || i.image?.imageUrl || '',
    condition:   i.condition || '',
    marketplace: marketplace,
    sold:        false
  })).filter(i => i.price > 0);
}

// Approximate conversion to USD for consistent median/avg calculations
// The app then re-converts to display currency using live rates
function convertToUsd(amount, currency) {
  const rates = { USD: 1, GBP: 1.27, AUD: 0.65, EUR: 1.08, CAD: 0.73 };
  return amount * (rates[currency] || 1);
}

async function searchBrowseFallback(token, searchTerm) {
  const results = await Promise.allSettled(
    ['EBAY_US', 'EBAY_GB'].map(mkt => fetchActiveFromMarket(token, searchTerm, mkt))
  );
  let allItems = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allItems = allItems.concat(r.value);
  }
  // Mark as pseudo-sold for value estimation
  allItems = allItems.map(i => ({ ...i, sold: false }));
  return { items: allItems.slice(0, 100), total: allItems.length, source: 'browse_fallback' };
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

