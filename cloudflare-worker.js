/**
 * PinScout — eBay Proxy Worker v3
 * Service Worker syntax for Cloudflare dashboard editor.
 *
 * SOLD DATA: Scrapes eBay's public completed/sold listings page directly.
 * No special API access needed — same data as the "View all on eBay" button.
 *
 * ACTIVE LISTINGS: Uses eBay Browse API (OAuth).
 *
 * ENVIRONMENT VARIABLES (Settings → Variables):
 *   EBAY_CLIENT_ID     → your App ID
 *   EBAY_CLIENT_SECRET → your Cert ID
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

  if (!query) return corsJson({ error: 'Missing ?q= parameter' }, 400);

  try {
    if (filter === 'sold') {
      const data = await scrapeSoldListings(query);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    } else {
      if (!self.EBAY_CLIENT_ID || !self.EBAY_CLIENT_SECRET) {
        return corsJson({ error: 'Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET env vars' }, 500);
      }
      const token = await getToken();
      const data  = await fetchActiveListings(token, query);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  } catch (err) {
    return corsJson({ error: err.message }, 502);
  }
}

// ══════════════════════════════════════════════════════
//  SOLD DATA — scrape eBay public completed listings
// ══════════════════════════════════════════════════════
async function scrapeSoldListings(query) {
  const searchTerm = query.toLowerCase().includes('disney') ? query : query + ' Disney pin';
  const encoded    = encodeURIComponent(searchTerm);

  const pageUrls = [1, 2, 3].map(p =>
    `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Complete=1&LH_Sold=1&_sop=13&_ipg=60&_pgn=${p}`
  );

  const pages = await Promise.allSettled(pageUrls.map(u => fetchEbayPage(u)));
  let allItems = [];

  for (const result of pages) {
    if (result.status === 'fulfilled' && result.value) {
      const items = parseSoldListingsHtml(result.value);
      allItems = allItems.concat(items);
      if (items.length === 0) break;
    }
  }

  const seen = new Set();
  allItems = allItems.filter(i => {
    if (!i.url || seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });

  return { items: allItems.slice(0, 100), total: allItems.length, source: 'ebay_scrape' };
}

async function fetchEbayPage(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  if (!resp.ok) return null;
  return await resp.text();
}

function parseSoldListingsHtml(html) {
  const items = [];
  const listingRegex = /<li[^>]+class="[^"]*s-item[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let match;

  while ((match = listingRegex.exec(html)) !== null) {
    const block = match[1];
    if (block.includes('s-item__placeholder') || block.includes('SHOP_ON_EBAY')) continue;

    // Title
    const titleMatch = block.match(/class="s-item__title[^"]*"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?\s*([\s\S]*?)<\/(?:h3|span|div|a)>/);
    const title = titleMatch ? cleanText(titleMatch[1]) : '';
    if (!title || title.length < 3) continue;

    // Price
    const priceMatch = block.match(/class="s-item__price"[^>]*>[\s\S]*?(\$[\d,]+\.?\d*)/);
    const price = parseFloat((priceMatch ? priceMatch[1] : '').replace(/[$,]/g, ''));
    if (!price || price <= 0) continue;

    // URL
    const urlMatch = block.match(/href="(https:\/\/www\.ebay\.com\/itm\/[^"?]+)/);
    const url = urlMatch ? urlMatch[1] : '';

    // Image — prefer larger size
    const imgMatch = block.match(/<img[^>]+(?:src|data-src)="(https:\/\/i\.ebayimg\.com\/[^"]+)"/);
    let image = imgMatch ? imgMatch[1] : '';
    if (image) image = image.replace(/\/s-l\d+\./, '/s-l400.');

    // Sold date
    const dateMatch = block.match(/class="[^"]*s-item__ended-date[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    let dateStr = dateMatch ? cleanText(dateMatch[1]) : '';
    if (!dateStr) {
      const d2 = block.match(/Sold\s+(\w+\s+\d+,\s+\d{4})/i);
      if (d2) dateStr = d2[1];
    }
    const date = dateStr ? parseDateStr(dateStr) : '';

    // Condition
    const condMatch = block.match(/class="SECONDARY_INFO"[^>]*>([\s\S]*?)<\/span>/);
    const condition = condMatch ? cleanText(condMatch[1]) : '';

    items.push({ title, price, currency: 'USD', pricingUsd: price, date, url, image, condition, marketplace: 'EBAY_US', sold: true });
  }

  return items;
}

function cleanText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseDateStr(str) {
  if (!str) return '';
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.toISOString();
  const daysAgo = str.match(/(\d+)\s+days?\s+ago/i);
  if (daysAgo) {
    const dt = new Date();
    dt.setDate(dt.getDate() - parseInt(daysAgo[1]));
    return dt.toISOString();
  }
  return str;
}

// ══════════════════════════════════════════════════════
//  ACTIVE LISTINGS — eBay Browse API
// ══════════════════════════════════════════════════════
async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;
  const credentials = btoa(`${self.EBAY_CLIENT_ID}:${self.EBAY_CLIENT_SECRET}`);
  const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });
  if (!resp.ok) { const b = await resp.text(); throw new Error(`OAuth failed (${resp.status}): ${b.substring(0,200)}`); }
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
  for (const r of results) { if (r.status === 'fulfilled') allItems = allItems.concat(r.value); }
  const seen = new Set();
  allItems = allItems.filter(i => { if (!i.url || seen.has(i.url)) return false; seen.add(i.url); return true; });
  return { items: allItems.slice(0, 40), total: allItems.length, source: 'browse' };
}

async function fetchActiveFromMarket(token, searchTerm, marketplace) {
  const resp = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(searchTerm)}&limit=30&sort=bestMatch`,
    { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplace, 'Content-Type': 'application/json' } }
  );
  if (!resp.ok) return [];
  const data = await resp.json();
  const rates = { USD: 1, GBP: 1.27, AUD: 0.65, EUR: 1.08, CAD: 0.73 };
  return (data.itemSummaries || []).map(i => ({
    title: i.title || '', price: parseFloat(i.price?.value || 0),
    currency: i.price?.currency || 'USD',
    pricingUsd: parseFloat(i.price?.value || 0) * (rates[i.price?.currency] || 1),
    date: '', url: i.itemWebUrl || '',
    image: i.thumbnailImages?.[0]?.imageUrl || i.image?.imageUrl || '',
    condition: i.condition || '', marketplace, sold: false
  })).filter(i => i.price > 0);
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '86400' };
}

function corsJson(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
