/**
 * PinScout — eBay Proxy Worker v4
 * Service Worker syntax for Cloudflare dashboard editor.
 *
 * SOLD DATA: Scrapes eBay's public completed/sold listings page.
 * Uses multiple parsing strategies for reliability.
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

  // Fetch 2 pages in parallel (eBay shows ~60 items per page)
  const pageUrls = [1, 2].map(p =>
    `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Complete=1&LH_Sold=1&_sop=13&_ipg=60&_pgn=${p}`
  );

  const pages = await Promise.allSettled(pageUrls.map(u => fetchEbayPage(u)));
  let allItems = [];

  for (const result of pages) {
    if (result.status === 'fulfilled' && result.value) {
      const items = parseEbayHtml(result.value);
      allItems = allItems.concat(items);
    }
  }

  // Dedupe by URL
  const seen = new Set();
  allItems = allItems.filter(i => {
    if (!i.url || seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });

  // Sort by date descending
  allItems.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  return {
    items: allItems.slice(0, 100),
    total: allItems.length,
    source: 'ebay_scrape',
    debug: `Fetched ${allItems.length} items from ${pages.filter(p=>p.status==='fulfilled').length} pages`
  };
}

async function fetchEbayPage(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
    }
  });
  if (!resp.ok) return null;
  return await resp.text();
}

function parseEbayHtml(html) {
  // Strategy 1: Try JSON-LD structured data first (most reliable)
  const jsonItems = parseJsonLd(html);
  if (jsonItems.length > 0) return jsonItems;

  // Strategy 2: Parse HTML item blocks
  return parseHtmlBlocks(html);
}

function parseJsonLd(html) {
  const items = [];
  // eBay sometimes embeds product data as JSON-LD
  const jsonLdRegex = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const list = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of list) {
        if (item['@type'] === 'Product' || item['@type'] === 'Offer') {
          const price = parseFloat(item.offers?.price || item.price || 0);
          if (price > 0) {
            items.push({
              title: item.name || item.offers?.name || '',
              price,
              currency: item.offers?.priceCurrency || 'USD',
              pricingUsd: price,
              date: item.offers?.priceValidUntil || '',
              url: item.offers?.url || item.url || '',
              image: item.image || (Array.isArray(item.image) ? item.image[0] : '') || '',
              condition: item.offers?.itemCondition?.replace('http://schema.org/','') || '',
              marketplace: 'EBAY_US',
              sold: true
            });
          }
        }
      }
    } catch(e) {}
  }
  return items;
}

function parseHtmlBlocks(html) {
  const items = [];

  // Split on s-item boundaries — more reliable than greedy regex
  // eBay wraps each result in a <li class="s-item ...">
  const parts = html.split(/(?=<li[^>]+class="[^"]*\bs-item\b)/);

  for (const block of parts) {
    if (!block.includes('s-item__price')) continue;
    if (block.includes('SHOP_ON_EBAY') || block.includes('s-item__placeholder')) continue;

    // Title: look for s-item__title content
    let title = '';
    const titleM = block.match(/class="s-item__title"[^>]*>([\s\S]*?)(?:<\/h3>|<\/span>|<\/div>)/);
    if (titleM) {
      title = stripTags(titleM[1]).trim();
      // eBay puts "New listing" as a span inside — remove it
      title = title.replace(/^New listing\s*/i, '').trim();
    }
    if (!title || title.length < 3) continue;

    // Price: match $ amount
    let price = 0;
    const priceM = block.match(/class="s-item__price"[^>]*>[\s\S]*?\$([\d,]+\.?\d*)/);
    if (priceM) price = parseFloat(priceM[1].replace(/,/g, ''));
    if (!price || price <= 0) continue;

    // URL
    let url = '';
    const urlM = block.match(/href="(https:\/\/www\.ebay\.com\/itm\/[^?"#]+)/);
    if (urlM) url = urlM[1];

    // Image — try data-src first (lazy-loaded), then src
    let image = '';
    const imgM = block.match(/<img[^>]+class="s-item__image-img[^"]*"[^>]*>/);
    if (imgM) {
      const srcM = imgM[0].match(/(?:data-src|src)="(https:\/\/i\.ebayimg\.com\/[^"]+)"/);
      if (srcM) image = srcM[1].replace(/\/s-l\d+\./, '/s-l400.');
    }
    // Fallback: any ebayimg URL in the block
    if (!image) {
      const anyImg = block.match(/https:\/\/i\.ebayimg\.com\/thumbs\/[^"'\s]+/);
      if (anyImg) image = anyImg[0].replace(/\/s-l\d+\./, '/s-l400.');
    }

    // Date — eBay shows sold date in s-item__ended-date or as "Sold  MMM DD, YYYY"
    let date = '';
    const datePatterns = [
      /class="[^"]*s-item__ended-date[^"]*"[^>]*>([\s\S]*?)<\/span>/,
      /class="[^"]*s-item__endedDate[^"]*"[^>]*>([\s\S]*?)<\/span>/,
      /Sold\s+(\w{3}\s+\d{1,2},?\s+\d{4})/i,
      /(\d{1,2}\s+\w{3}\s+\d{4})/,
    ];
    for (const pat of datePatterns) {
      const dm = block.match(pat);
      if (dm) {
        const raw = stripTags(dm[1]).trim();
        const parsed = new Date(raw);
        if (!isNaN(parsed)) { date = parsed.toISOString(); break; }
        // Try "X days ago"
        const ago = raw.match(/(\d+)\s+days?\s+ago/i);
        if (ago) {
          const d = new Date(); d.setDate(d.getDate() - parseInt(ago[1]));
          date = d.toISOString(); break;
        }
      }
    }

    // Condition
    let condition = '';
    const condM = block.match(/class="SECONDARY_INFO"[^>]*>([\s\S]*?)<\/span>/);
    if (condM) condition = stripTags(condM[1]).trim();

    items.push({
      title,
      price,
      currency: 'USD',
      pricingUsd: price,
      date,
      url,
      image,
      condition,
      marketplace: 'EBAY_US',
      sold: true
    });
  }

  return items;
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
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
    title: i.title || '',
    price: parseFloat(i.price?.value || 0),
    currency: i.price?.currency || 'USD',
    pricingUsd: parseFloat(i.price?.value || 0) * (rates[i.price?.currency] || 1),
    date: '',
    url: i.itemWebUrl || '',
    image: i.thumbnailImages?.[0]?.imageUrl || i.image?.imageUrl || '',
    condition: i.condition || '',
    marketplace,
    sold: false
  })).filter(i => i.price > 0);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400'
  };
}

function corsJson(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
