/**
 * PinScout — eBay CORS Proxy
 * Deploy this to a free Cloudflare Worker.
 * It receives requests from the PinScout app and forwards them to eBay,
 * adding the CORS headers that eBay's servers don't include themselves.
 */

export default {
  async fetch(request) {
    // Handle preflight (OPTIONS) requests from the browser
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    const incomingUrl = new URL(request.url);
    const targetUrl   = incomingUrl.searchParams.get('url');

    // Validate that a target URL was provided
    if (!targetUrl) {
      return jsonResponse({ error: 'Missing ?url= parameter' }, 400);
    }

    // Only allow calls to eBay's Finding Service — nothing else
    if (!targetUrl.startsWith('https://svcs.ebay.com/services/search/FindingService/')) {
      return jsonResponse({ error: 'Only eBay Finding Service URLs are allowed' }, 403);
    }

    try {
      const ebayResponse = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'PinScout/1.0',
          'Accept':     'application/json'
        }
      });

      const body = await ebayResponse.text();

      return new Response(body, {
        status:  ebayResponse.status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders()
        }
      });
    } catch (err) {
      return jsonResponse({ error: 'Upstream fetch failed: ' + err.message }, 502);
    }
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}
