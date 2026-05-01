/**
 * PinScout — eBay Proxy Worker v5
 * Service Worker syntax for Cloudflare dashboard editor.
 *
 * ENDPOINTS:
 *   ?q=QUERY&filter=sold    — scrape eBay completed/sold listings
 *   ?q=QUERY&filter=active  — eBay Browse API active listings
 *   ?q=QUERY&filter=debug   — returns raw eBay HTML snippet for diagnosis
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
    // Debug endpoint — returns raw HTML snippet so we can see what eBay sends
    if (filter === 'debug') {
      const searchTerm = query.toLowerCase().includes('disney') ? query : query + ' Disney pin';
      const encoded = encodeURIComponent(searchTerm);
      const ebayUrl = `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Complete=1&LH_Sold=1&_sop=13&_ipg=10`;
      const html = await fetchEbayPage(ebayUrl);
      if (!html) return corsJson({ error: 'eBay returned no content', url: ebayUrl }, 502);
      // Return first 8000 chars of HTML and some key stats
      const hasItems   = html.includes('s-item');
      const hasCards   = html.includes('s-card');
      const itemCount  = (html.match(/class="s-item/g) || []).length;
      const cardCount  = (html.match(/class="s-card/g) || []).length;
      const hasCaptcha = html.toLowerCase().includes('captcha') || html.toLowerCase().includes('robot');
      return corsJson({
        url: ebayUrl,
        httpOk: true,
        htmlLength: html.length,
        hasItems,
        hasCards,
        itemCount,
        cardCount,
        hasCaptcha,
        snippet: html.substring(0, 6000)
      });
    }

    if (filter === 'sold') {
      const data = await scrapeSoldListings(query);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // Active listings
    if (!self.EBAY_CLIENT_ID || !self.EBAY_CLIENT_SECRET) {
      return corsJson({ error: 'Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET env vars' }, 500);
    }
    const token = await getToken();
    const data  = await fetchActiveListings(token, query);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });

  } catch (err) {
    return corsJson({ error: err.message, stack: err.stack }, 502);
  }
}

// ══════════════════════════════════════════════════════
//  SOLD DATA — scrape eBay public completed listings
// ══════════════════════════════════════════════════════
async function scrapeSoldListings(query) {
  const searchTerm = query.toLowerCase().includes('disney') ? query : query + ' Disney pin';
  const encoded    = encodeURIComponent(searchTerm);

  const pageUrls = [1, 2].map(p =>
    `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Complete=1&LH_Sold=1&_sop=13&_ipg=60&_pgn=${p}`
  );

  const pages = await Promise.allSettled(pageUrls.map(u => fetchEbayPage(u)));
  let allItems = [];
  let debugInfo = [];

  for (let i = 0; i < pages.length; i++) {
    const result = pages[i];
    if (result.status === 'rejected') {
      debugInfo.push(`Page ${i+1}: fetch rejected — ${result.reason}`);
      continue;
    }
    const html = result.value;
    if (!html) { debugInfo.push(`Page ${i+1}: null response`); continue; }

    const hasCaptcha = html.toLowerCase().includes('captcha') || html.toLowerCase().includes('g-recaptcha');
    if (hasCaptcha) { debugInfo.push(`Page ${i+1}: CAPTCHA detected`); continue; }

    const items = parseEbayPage(html);
    debugInfo.push(`Page ${i+1}: htmlLen=${html.length} s-item=${(html.match(/s-item/g)||[]).length} s-card=${(html.match(/s-card/g)||[]).length} parsed=${items.length}`);
    allItems = allItems.concat(items);
    if (items.length === 0) break;
  }

  const seen = new Set();
  allItems = allItems.filter(i => {
    if (!i.url || seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });

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
    debug: debugInfo.join(' | ')
  };
}

async function fetchEbayPage(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
    redirect: 'follow'
  });
  if (!resp.ok) return null;
  return await resp.text();
}

function parseEbayPage(html) {
  // Try both layout variants eBay uses
  const bySCard  = parseLayout(html, 's-card',  's-card__title',  's-card__price',  's-card__image', 'su-link');
  if (bySCard.length > 0) return bySCard;
  return parseLayout(html, 's-item', 's-item__title', 's-item__price', 's-item__image-img', 's-item__link');
}

function parseLayout(html, itemClass, titleClass, priceClass, imgClass, linkClass) {
  const items = [];

  // Split HTML on item boundaries
  const splitOn = new RegExp(`(?=<li[^>]+class="[^"]*\\b${itemClass}\\b)`);
  const blocks  = html.split(splitOn);

  for (const block of blocks) {
    if (block.length < 100) continue;
    if (block.includes('SHOP_ON_EBAY') || block.includes('placeholder')) continue;
    if (!block.includes(priceClass)) continue;

    // Title
    let title = extractClass(block, titleClass);
    if (!title) title = extractTag(block, 'h3');
    if (!title || title.length < 3) continue;
    title = title.replace(/^New listing\s*/i, '').trim();

    // Price — look for $ amount
    const priceRaw = extractClass(block, priceClass);
    const priceMatch = (priceRaw || block).match(/\$\s*([\d,]+\.?\d*)/);
    if (!priceMatch) continue;
    const price = parseFloat(priceMatch[1].replace(/,/g, ''));
    if (!price || price <= 0) continue;

    // URL — prefer item link, fallback to any itm/ URL
    let url = extractAttr(block, linkClass, 'href');
    if (!url) { const m = block.match(/href="(https:\/\/www\.ebay\.com\/itm\/[^"?#]+)/); url = m ? m[1] : ''; }
    if (!url) { const m = block.match(/href="(https:\/\/ebay\.com\/itm\/[^"?#]+)/); url = m ? m[1] : ''; }

    // Image
    let image = extractAttr(block, imgClass, 'data-src') || extractAttr(block, imgClass, 'src');
    if (!image) {
      const m = block.match(/https:\/\/i\.ebayimg\.com\/[^\s"']+/);
      image = m ? m[0] : '';
    }
    if (image) image = image.replace(/\/s-l\d+\./, '/s-l400.');

    // Date — multiple patterns
    let date = '';
    const datePatterns = [
      /class="[^"]*ended-date[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
      /class="[^"]*endedDate[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
      /SOLD\s+([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})/,
      /(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})/,
      /([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/,
    ];
    for (const pat of datePatterns) {
      const m = block.match(pat);
      if (m) {
        const raw = stripHtml(m[1] || m[0]).trim();
        const daysAgo = raw.match(/(\d+)\s+days?\s+ago/i);
        if (daysAgo) {
          const d = new Date(); d.setDate(d.getDate() - parseInt(daysAgo[1]));
          date = d.toISOString(); break;
        }
        const parsed = new Date(raw);
        if (!isNaN(parsed.getTime())) { date = parsed.toISOString(); break; }
      }
    }

    // Condition
    const condition = extractClass(block, 'SECONDARY_INFO') || extractClass(block, 's-item__subtitle') || '';

    items.push({
      title, price,
      currency: 'USD', pricingUsd: price,
      date, url, image, condition,
      marketplace: 'EBAY_US', sold: true
    });
  }

  return items;
}

// ── HTML helpers ──
function extractClass(html, cls) {
  const re = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:span|div|h3|h2|li|a)>`, 'i');
  const m  = html.match(re);
  return m ? stripHtml(m[1]) : '';
}

function extractTag(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m  = html.match(re);
  return m ? stripHtml(m[1]) : '';
}

function extractAttr(html, cls, attr) {
  const re = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*${attr}="([^"]+)"`, 'i');
  const m  = html.match(re);
  if (m) return m[1];
  // Also try attr before class
  const re2 = new RegExp(`${attr}="([^"]+)"[^>]*class="[^"]*\\b${cls}\\b`, 'i');
  const m2  = html.match(re2);
  return m2 ? m2[1] : '';
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/\s+/g,' ').trim();
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
    { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplace } }
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
  return { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'*','Access-Control-Max-Age':'86400' };
}
function corsJson(obj, status) {
  return new Response(JSON.stringify(obj), { status: status||200, headers: {'Content-Type':'application/json',...corsHeaders()} });
}
