/**
 * Cloudflare Worker - Self-Hosted URL Shortener
 *
 * Features:
 * - Short URL redirects: /s/{code} → full URL with UTM parameters
 * - Full CRUD API with Bearer token authentication
 * - Click analytics tracking per source
 * - Soft delete + restore + permanent delete
 * - Campaign-based UTM injection
 *
 * Deploy: wrangler deploy
 * Companion article: https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/
 */

// KV namespace binding: URL_MAPPINGS
// Configure in wrangler.toml

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Short URL redirect: /s/{code}
    if (url.pathname.startsWith('/s/')) {
      return handleShortUrl(url, env);
    }

    // API: Create short URL (authenticated)
    if (url.pathname === '/api/shorten' && request.method === 'POST') {
      return handleCreateShortUrl(request, env);
    }

    // API: Get click statistics
    if (url.pathname.startsWith('/api/stats/')) {
      return handleGetStats(url, env);
    }

    // API: List all active URLs (authenticated)
    if (url.pathname === '/api/urls' && request.method === 'GET') {
      return handleListUrls(request, env);
    }

    // API: Update URL (authenticated)
    if (url.pathname.startsWith('/api/urls/') && request.method === 'PUT') {
      return handleUpdateUrl(request, url, env);
    }

    // API: Restore deleted URL (authenticated) - must be before generic DELETE
    if (url.pathname.match(/^\/api\/urls\/[^/]+\/restore$/) && request.method === 'POST') {
      return handleRestoreUrl(request, url, env);
    }

    // API: Permanently delete URL (authenticated) - must be before generic DELETE
    if (url.pathname.match(/^\/api\/urls\/[^/]+\/permanent$/) && request.method === 'DELETE') {
      return handlePermanentDelete(request, url, env);
    }

    // API: List deleted URLs (authenticated)
    if (url.pathname === '/api/urls/deleted' && request.method === 'GET') {
      return handleListDeletedUrls(request, env);
    }

    // API: Soft delete URL (authenticated)
    if (url.pathname.startsWith('/api/urls/') && request.method === 'DELETE') {
      return handleDeleteUrl(request, url, env);
    }

    return new Response('URL Shortener - see /api/* for endpoints', { status: 200 });
  },
};

/**
 * Redirect /s/{code} to the target URL with UTM parameters
 */
async function handleShortUrl(url, env) {
  const code = url.pathname.split('/s/')[1];

  if (!code) {
    return new Response('Invalid short URL', { status: 400 });
  }

  try {
    const mapping = await env.URL_MAPPINGS.get(code, { type: 'json' });

    if (!mapping || mapping.deleted) {
      return new Response(null, { status: 404 });
    }

    const targetUrl = new URL(mapping.url);
    const source = url.searchParams.get('s') || 'short';

    // Inject UTM parameters for analytics tracking
    targetUrl.searchParams.set('utm_source', source);
    targetUrl.searchParams.set('utm_medium', 'shortlink');
    targetUrl.searchParams.set('utm_campaign', mapping.campaign || 'general');
    targetUrl.searchParams.set('utm_content', code);

    // Track asynchronously (non-blocking)
    incrementStats(code, env, source);

    // 302 temporary redirect (avoids browser caching, ensures deleted URLs stop working immediately)
    return Response.redirect(targetUrl.toString(), 302);
  } catch (error) {
    console.error('Error handling short URL:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * POST /api/shorten — Create a new short URL
 * Body: { url, code?, campaign?, notes? }
 */
async function handleCreateShortUrl(request, env) {
  try {
    if (!verifyApiKey(request, env)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const body = await request.json();
    const { url: longUrl, code, campaign, notes } = body;

    if (!longUrl) {
      return jsonResponse({ error: 'url is required' }, 400);
    }

    if (notes !== undefined && notes !== null && notes !== '') {
      if (typeof notes !== 'string') {
        return jsonResponse({ error: 'notes must be a string' }, 400);
      }
      if (notes.length > 500) {
        return jsonResponse({ error: 'notes must be 500 characters or less' }, 400);
      }
    }

    const shortCode = code || await generateShortCode(env);

    const existing = await env.URL_MAPPINGS.get(shortCode);
    if (existing) {
      return jsonResponse({ error: 'Short code already exists' }, 409);
    }

    const mapping = {
      url: longUrl,
      campaign: campaign || 'general',
      created: new Date().toISOString(),
    };

    if (notes && notes.trim()) {
      mapping.notes = notes.trim();
    }

    await env.URL_MAPPINGS.put(shortCode, JSON.stringify(mapping));

    // Initialize stats
    await env.URL_MAPPINGS.put(`stats:${shortCode}`, JSON.stringify({
      total: 0,
      sources: {},
    }));

    const baseUrl = new URL(request.url).origin;
    return jsonResponse({
      shortUrl: `${baseUrl}/s/${shortCode}`,
      code: shortCode,
      longUrl,
    });
  } catch (error) {
    console.error('Error creating short URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * GET /api/stats/{code} — Get click statistics for a short URL
 */
async function handleGetStats(url, env) {
  const code = url.pathname.split('/api/stats/')[1];

  if (!code) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const stats = await env.URL_MAPPINGS.get(`stats:${code}`, { type: 'json' });

    if (!stats) {
      return jsonResponse({ error: 'Stats not found' }, 404);
    }

    return jsonResponse(stats);
  } catch (error) {
    console.error('Error getting stats:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * GET /api/urls — List all active (non-deleted) URLs
 * Excludes blog_post campaign URLs (auto-generated by publish pipeline)
 */
async function handleListUrls(request, env) {
  if (!verifyApiKey(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    const urls = [];
    let cursor = null;

    do {
      const listResult = await env.URL_MAPPINGS.list({ cursor });

      for (const key of listResult.keys) {
        if (key.name.startsWith('stats:')) continue;

        const mapping = await env.URL_MAPPINGS.get(key.name, { type: 'json' });
        if (!mapping || mapping.deleted) continue;

        // Optionally skip auto-generated blog_post campaign URLs
        // Remove this filter if you want to see all URLs
        // if (mapping.campaign === 'blog_post') continue;

        const stats = await env.URL_MAPPINGS.get(`stats:${key.name}`, { type: 'json' }) || {
          total: 0,
          sources: {},
        };

        const urlObj = {
          code: key.name,
          url: mapping.url,
          campaign: mapping.campaign,
          created: mapping.created,
          stats,
        };

        if (mapping.notes) urlObj.notes = mapping.notes;

        urls.push(urlObj);
      }

      cursor = listResult.list_complete ? null : listResult.cursor;
    } while (cursor);

    urls.sort((a, b) => new Date(b.created) - new Date(a.created));

    return jsonResponse({ urls, total: urls.length });
  } catch (error) {
    console.error('Error listing URLs:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * PUT /api/urls/{code} — Update URL, campaign, code, or notes
 */
async function handleUpdateUrl(request, url, env) {
  if (!verifyApiKey(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const oldCode = url.pathname.split('/api/urls/')[1];
  if (!oldCode) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(oldCode, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    const body = await request.json();
    const { url: newUrl, campaign, code: newCode, notes } = body;

    if (notes !== undefined && notes !== null) {
      if (typeof notes !== 'string') {
        return jsonResponse({ error: 'notes must be a string' }, 400);
      }
      if (notes.length > 500) {
        return jsonResponse({ error: 'notes must be 500 characters or less' }, 400);
      }
    }

    const updated = {
      url: newUrl || existing.url,
      campaign: campaign !== undefined ? campaign : existing.campaign,
      created: existing.created,
      updated: new Date().toISOString(),
    };

    if (notes !== undefined) {
      if (notes.trim()) updated.notes = notes.trim();
    } else if (existing.notes) {
      updated.notes = existing.notes;
    }

    if (newCode && newCode !== oldCode) {
      const existingNew = await env.URL_MAPPINGS.get(newCode);
      if (existingNew) {
        return jsonResponse({ error: 'New code already exists' }, 409);
      }

      await env.URL_MAPPINGS.put(newCode, JSON.stringify(updated));

      const stats = await env.URL_MAPPINGS.get(`stats:${oldCode}`, { type: 'json' });
      if (stats) {
        await env.URL_MAPPINGS.put(`stats:${newCode}`, JSON.stringify(stats));
        await env.URL_MAPPINGS.delete(`stats:${oldCode}`);
      }

      await env.URL_MAPPINGS.delete(oldCode);

      return jsonResponse({ code: newCode, oldCode, ...updated });
    }

    await env.URL_MAPPINGS.put(oldCode, JSON.stringify(updated));
    return jsonResponse({ code: oldCode, ...updated });
  } catch (error) {
    console.error('Error updating URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * DELETE /api/urls/{code} — Soft delete (marks deleted=true, preserves data)
 */
async function handleDeleteUrl(request, url, env) {
  if (!verifyApiKey(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const code = url.pathname.split('/api/urls/')[1];
  if (!code) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(code, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    const updated = {
      ...existing,
      deleted: true,
      deletedAt: new Date().toISOString(),
    };

    await env.URL_MAPPINGS.put(code, JSON.stringify(updated));

    return jsonResponse({ deleted: true, code });
  } catch (error) {
    console.error('Error deleting URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * POST /api/urls/{code}/restore — Restore a soft-deleted URL
 */
async function handleRestoreUrl(request, url, env) {
  if (!verifyApiKey(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const match = url.pathname.match(/^\/api\/urls\/([^/]+)\/restore$/);
  const code = match ? match[1] : null;

  if (!code) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(code, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    if (!existing.deleted) {
      return jsonResponse({ error: 'Short URL is not deleted' }, 400);
    }

    const restored = { ...existing, deleted: false, restoredAt: new Date().toISOString() };
    delete restored.deletedAt;

    await env.URL_MAPPINGS.put(code, JSON.stringify(restored));

    return jsonResponse({ restored: true, code, url: restored.url });
  } catch (error) {
    console.error('Error restoring URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * GET /api/urls/deleted — List all soft-deleted URLs
 */
async function handleListDeletedUrls(request, env) {
  if (!verifyApiKey(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    const urls = [];
    let cursor = null;

    do {
      const listResult = await env.URL_MAPPINGS.list({ cursor });

      for (const key of listResult.keys) {
        if (key.name.startsWith('stats:')) continue;

        const mapping = await env.URL_MAPPINGS.get(key.name, { type: 'json' });
        if (mapping && mapping.deleted) {
          const urlObj = {
            code: key.name,
            url: mapping.url,
            campaign: mapping.campaign,
            created: mapping.created,
            deletedAt: mapping.deletedAt,
          };
          if (mapping.notes) urlObj.notes = mapping.notes;
          urls.push(urlObj);
        }
      }

      cursor = listResult.list_complete ? null : listResult.cursor;
    } while (cursor);

    urls.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));

    return jsonResponse({ urls, total: urls.length });
  } catch (error) {
    console.error('Error listing deleted URLs:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * DELETE /api/urls/{code}/permanent — Permanently delete from KV (irreversible)
 */
async function handlePermanentDelete(request, url, env) {
  if (!verifyApiKey(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const match = url.pathname.match(/^\/api\/urls\/([^/]+)\/permanent$/);
  const code = match ? match[1] : null;

  if (!code) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(code, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    if (!existing.deleted) {
      return jsonResponse({ error: 'Only soft-deleted URLs can be permanently removed' }, 400);
    }

    await env.URL_MAPPINGS.delete(code);
    await env.URL_MAPPINGS.delete(`stats:${code}`);

    return jsonResponse({ permanentlyDeleted: true, code });
  } catch (error) {
    console.error('Error permanently deleting URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * Increment click stats asynchronously (non-blocking)
 */
async function incrementStats(code, env, source) {
  try {
    const statsKey = `stats:${code}`;
    const stats = await env.URL_MAPPINGS.get(statsKey, { type: 'json' }) || {
      total: 0,
      sources: {},
    };

    stats.total += 1;
    stats.sources[source] = (stats.sources[source] || 0) + 1;
    stats.lastAccess = new Date().toISOString();

    await env.URL_MAPPINGS.put(statsKey, JSON.stringify(stats));
  } catch (error) {
    console.error('Error incrementing stats:', error);
  }
}

/**
 * Generate a unique numeric short code (starts at 10, increments)
 * Codes 0-9 are reserved for manual use
 */
async function generateShortCode(env) {
  let num = 10;
  const maxAttempts = 10000;

  while (num < maxAttempts) {
    const code = String(num);
    const existing = await env.URL_MAPPINGS.get(code);
    if (!existing) return code;
    num++;
  }

  throw new Error('Failed to generate unique short code');
}

/**
 * Verify Bearer token API key
 */
function verifyApiKey(request, env) {
  const authHeader = request.headers.get('Authorization');
  const apiKey = env.API_KEY;
  return authHeader && authHeader === `Bearer ${apiKey}`;
}

/**
 * Return JSON response with CORS headers
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
