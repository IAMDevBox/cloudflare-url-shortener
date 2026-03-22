# cloudflare-url-shortener

A production-ready, self-hosted URL shortener built with **Cloudflare Workers** and **KV storage**.
Zero cost, global edge performance, and full CRUD admin API with click analytics.

> 📖 **Full tutorial**: [Building a Self-Hosted URL Shortener with Cloudflare Workers](https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/?utm_source=github&utm_medium=companion-repo&utm_campaign=cloudflare-url-shortener)

## Features

- **Short URL redirects** — `/s/{code}` → full URL with automatic UTM parameter injection
- **Click analytics** — per-source tracking (twitter, linkedin, direct, etc.)
- **Full CRUD API** — create, list, update, soft-delete, restore, permanent-delete
- **API key authentication** — Bearer token for all write operations
- **Campaign tagging** — organize URLs by campaign for GA4 segmentation
- **Notes field** — admin annotations per URL
- **Soft delete + restore** — data is preserved until you permanently remove it
- **CORS support** — works with any frontend admin dashboard
- **Zero cost** — fits within Cloudflare's free tier (100k requests/day)

## Architecture

```
User → /s/{code} → Cloudflare Worker (edge, <15ms) → KV lookup → 302 redirect + UTM
                                                     ↓
                                               Stats tracking (async)
```

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/IAMDevBox/cloudflare-url-shortener.git
cd cloudflare-url-shortener
npm install
```

### 2. Create a KV namespace

```bash
wrangler kv:namespace create URL_MAPPINGS
# Copy the id from the output
```

### 3. Configure `wrangler.toml`

Replace the placeholders:

```toml
[[kv_namespaces]]
binding = "URL_MAPPINGS"
id = "YOUR_KV_NAMESPACE_ID"   # from step 2

[[routes]]
pattern = "yourdomain.com/s/*"
zone_name = "yourdomain.com"
```

### 4. Set your API key

```bash
wrangler secret put API_KEY
# Enter a strong secret when prompted
```

### 5. Deploy

```bash
wrangler deploy
```

That's it — your URL shortener is live at `https://yourdomain.com/s/*`.

## API Reference

All write endpoints require `Authorization: Bearer YOUR_API_KEY`.

### Create a short URL

```bash
curl -X POST https://yourdomain.com/api/shorten \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/very/long/blog/post/",
    "code": "oauth",          # optional custom code (auto-generated if omitted)
    "campaign": "blog_post",  # UTM campaign tag
    "notes": "OAuth guide"    # optional admin note
  }'
```

Response:
```json
{
  "shortUrl": "https://yourdomain.com/s/oauth",
  "code": "oauth",
  "longUrl": "https://example.com/very/long/blog/post/"
}
```

### Get click statistics

```bash
curl https://yourdomain.com/api/stats/oauth
```

Response:
```json
{
  "total": 142,
  "sources": {
    "twitter": 98,
    "linkedin": 32,
    "direct": 12
  },
  "lastAccess": "2025-11-27T10:30:00Z"
}
```

### List all active URLs

```bash
curl https://yourdomain.com/api/urls \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Update a URL

```bash
curl -X PUT https://yourdomain.com/api/urls/oauth \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/new-url/", "campaign": "updated"}'
```

### Soft delete (recoverable)

```bash
curl -X DELETE https://yourdomain.com/api/urls/oauth \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Restore a deleted URL

```bash
curl -X POST https://yourdomain.com/api/urls/oauth/restore \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Permanent delete (irreversible)

```bash
# Must soft-delete first, then permanently remove
curl -X DELETE https://yourdomain.com/api/urls/oauth/permanent \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Python Client

The included `client.py` provides a typed Python wrapper:

```python
from client import URLShortenerClient

client = URLShortenerClient()  # reads SHORTENER_API_KEY + SHORTENER_BASE_URL from env

# Create
short = client.create("https://example.com/post/", campaign="twitter")

# Analytics
stats = client.get_stats("oauth")
print(stats["total"])  # 142

# List all
for url in client.list_urls():
    print(f"/s/{url['code']} → {url['url']}")
```

Environment variables:
```bash
export SHORTENER_API_KEY=your-secret-key
export SHORTENER_BASE_URL=https://yourdomain.com
```

## Testing

Run the full integration test suite against a local dev instance:

```bash
# Terminal 1: start local worker
npx wrangler dev --local

# Terminal 2: run tests
API_KEY=test-key node test_worker.js
```

Or against your deployed worker:

```bash
BASE_URL=https://yourdomain.com API_KEY=your-key node test_worker.js
```

## UTM Parameter Injection

Every redirect automatically injects UTM parameters:

```
/s/oauth?s=twitter
    ↓
https://example.com/post/?utm_source=twitter&utm_medium=shortlink&utm_campaign=blog_post&utm_content=oauth
```

The `?s=` query parameter sets `utm_source`. Omit it to get `utm_source=short` (default).

## Cost Analysis

Cloudflare Workers **free tier** per day:
- 100,000 Worker requests
- 1GB KV storage
- 100,000 KV reads + 1,000 KV writes

A typical blog gets ~500 short URL clicks/day — well within free tier.

| Service | Monthly cost |
|---------|-------------|
| Bitly Pro | $29 |
| TinyURL Pro | $9.99 |
| **This solution** | **$0** |

## Related Resources

- [Building a Self-Hosted URL Shortener with Cloudflare Workers](https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/?utm_source=github&utm_medium=companion-repo&utm_campaign=cloudflare-url-shortener) — full tutorial on IAMDevBox
- [Cloudflare Workers KV Tutorial](https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/?utm_source=github&utm_medium=companion-repo&utm_campaign=cloudflare-url-shortener#step-2-configuration) — KV storage configuration deep-dive
- [OAuth 2.0 Developer Guide](https://www.iamdevbox.com/posts/oauth-20-complete-developer-guide-authorization-authentication/?utm_source=github&utm_medium=companion-repo&utm_campaign=cloudflare-url-shortener) — if you're adding OAuth authentication to your Workers
- [IAM Tools Comparison](https://www.iamdevbox.com/posts/iam-tools-comparison-complete-guide-to-identity-platforms/?utm_source=github&utm_medium=companion-repo&utm_campaign=cloudflare-url-shortener) — comparing identity and access management platforms
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/) — official Cloudflare documentation

## License

MIT — use freely in your own projects.
