/**
 * PinScout — eBay Proxy Worker v7
 * Service Worker syntax for Cloudflare dashboard editor.
 *
 * SOLD DATA: Uses "eBay Average Selling Price" API via RapidAPI.
 * Free tier available — sign up at rapidapi.com and subscribe to:
 * "eBay Average Selling Price" by ecommet (or rest-endpoint)
 *
 * ACTIVE LISTINGS: Uses eBay Browse API (OAuth).
 *
 * ENVIRONMENT VARIABLES (Cloudflare Worker Settings → Variables):
 *   RAPIDAPI_KEY        → your RapidAPI key
 *   EBAY_CLIENT_ID      → your eBay App ID
 *   EBAY_CLIENT_SECRET  → your eBay Cert ID
 */

let cachedToken = null;
let tokenExpiry = 0;

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url    = new URL(request.url);
  const query  = url.searchParams.get('q');
  const filter = url.searchParams.get('filter') || 'sold';

  if (!query) return corsJson({ error: 'Missing ?q= parameter', items: [] }, 400);

  try {
    if (filter === 'sold') {
      if (!self.RAPIDAPI_KEY) {
        return corsJson({
          error: 'RAPIDAPI_KEY not set in Worker environment variables.',
          setup: 'Sign up at rapidapi.com, subscribe to "eBay Average Selling Price" (free tier), then add RAPIDAPI_KEY to Worker Settings → Variables.',
          items: [], total: 0, source: 'no_key'
        }, 200);
      }
      const data = await fetchSoldViaRapidAPI(query);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // Active listings
    if (!self.EBAY_CLIENT_ID || !self.EBAY_CLIENT_SECRET) {
      return corsJson({ error: 'Missing eBay OAuth env vars', items: [] }, 200);
    }
    const token = await getToken();
    const data  = await fetchActiveListings(token, query);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });

  } catch (err) {
    return corsJson({ error: err.message, items: [], total: 0 }, 200);
  }
}

// ══════════════════════════════════════════════════════
//  SOLD DATA via RapidAPI "eBay Average Selling Price"
//  https://rapidapi.com/ecommet/api/ebay-average-selling-price
// ══════════════════════════════════════════════════════
async function fetchSoldViaRapidAPI(query) {
  const keywords = query.toLowerCase().includes('disney') ? query : query + ' Disney pin';

  const body = {
    keywords:           keywords,
    max_search_results: 120,
    remove_outliers:    false,
    site_id:            '0'  // eBay US — also pulls international results
  };

  const resp = await fetch('https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-rapidapi-host':   'ebay-average-selling-price.p.rapidapi.com',
      'x-rapidapi-key':    self.RAPIDAPI_KEY
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`RapidAPI error ${resp.status}: ${txt.substring(0, 300)}`);
  }

  const data = await resp.json();

  if (!data.success && data.message) {
    throw new Error(`RapidAPI: ${data.message}`);
  }

  const products = data.products || [];
  const items = products.map(p => {
    const price = parseFloat(p.sale_price || 0);
    return {
      title:       p.title      || '',
      price:       price,
      currency:    'USD',
      pricingUsd:  price,
      date:        p.date_sold  ? parseSoldDate(p.date_sold) : '',
      url:         p.link       || '',
      image:       p.image_url  ? p.image_url.replace(/\/s-l\d+\./, '/s-l400.') : '',
      condition:   p.condition  || '',
      marketplace: 'EBAY_US',
      sold:        true
    };
  }).filter(i => i.price > 0);

  return {
    items,
    total:        items.length,
    avg_price:    data.average_price  || null,
    median_price: data.median_price   || null,
    min_price:    data.min_price      || null,
    max_price:    data.max_price      || null,
    response_url: data.response_url   || null,
    source:       'rapidapi'
  };
}

function parseSoldDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

// ══════════════════════════════════════════════════════
//  ACTIVE LISTINGS — eBay Browse API (OAuth)
// ══════════════════════════════════════════════════════
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
    const b = await resp.text();
    throw new Error(`OAuth failed (${resp.status}): ${b.substring(0, 200)}`);
  }
  const json = await resp.json();
  cachedToken = json.access_token;
  tokenExpiry = now + (90 * 60 * 1000);
  return cachedToken;
}

async function fetchActiveListings(token, query) {
  const searchTerm = query.toLowerCase().includes('disney') ? query : query + ' Disney pin';
  const results = await Promise.allSettled(
    ['EBAY_US', 'EBAY_GB'].map(mkt => fetchActiveFromMarket(token, searchTerm, mkt))
  );
  let allItems = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allItems = allItems.concat(r.value);
  }
  const seen = new Set();
  allItems = allItems.filter(i => {
    if (!i.url || seen.has(i.url)) return false;
    seen.add(i.url); return true;
  });
  return { items: allItems.slice(0, 40), total: allItems.length, source: 'browse' };
}

async function fetchActiveFromMarket(token, searchTerm, marketplace) {
  const resp = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(searchTerm)}&limit=30&sort=bestMatch`,
    { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplace } }
  );
  if (!resp.ok) return [];
  const data = await resp.json();
  const rates = { USD: 1, GBP: 1.27, AUD: 0.65, EUR: 1.08, CAD: 0.73 };
  return (data.itemSummaries || []).map(i => ({
    title:       i.title || '',
    price:       parseFloat(i.price?.value || 0),
    currency:    i.price?.currency || 'USD',
    pricingUsd:  parseFloat(i.price?.value || 0) * (rates[i.price?.currency] || 1),
    date:        '',
    url:         i.itemWebUrl || '',
    image:       i.thumbnailImages?.[0]?.imageUrl || i.image?.imageUrl || '',
    condition:   i.condition || '',
    marketplace,
    sold:        false
  })).filter(i => i.price > 0);
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
