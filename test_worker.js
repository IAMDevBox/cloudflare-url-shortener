/**
 * Integration tests for the URL Shortener Worker
 * Run with: npx wrangler dev --local (in one terminal), then node test_worker.js
 *
 * Or run tests against your deployed worker:
 *   BASE_URL=https://yourdomain.com API_KEY=your-key node test_worker.js
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:8787';
const API_KEY = process.env.API_KEY || 'test-key';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function runTests() {
  console.log('\n🧪 URL Shortener Worker Tests\n');

  const testCode = `test-${Date.now()}`;

  // Create
  console.log('📌 Create short URL');
  let created;
  await test('POST /api/shorten creates a URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: 'https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/',
        code: testCode,
        campaign: 'test',
        notes: 'Integration test',
      }),
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    created = await resp.json();
    assert(created.code === testCode, `Expected code ${testCode}, got ${created.code}`);
    assert(created.shortUrl.includes(`/s/${testCode}`), 'shortUrl should include the code');
  });

  await test('POST /api/shorten rejects duplicate code', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/', code: testCode }),
    });
    assert(resp.status === 409, `Expected 409 Conflict, got ${resp.status}`);
  });

  await test('POST /api/shorten requires authentication', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' }),
    });
    assert(resp.status === 401, `Expected 401, got ${resp.status}`);
  });

  // Stats
  console.log('\n📊 Statistics');
  await test('GET /api/stats/{code} returns stats', async () => {
    const resp = await fetch(`${BASE_URL}/api/stats/${testCode}`);
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const stats = await resp.json();
    assert(typeof stats.total === 'number', 'stats.total should be a number');
    assert(typeof stats.sources === 'object', 'stats.sources should be an object');
  });

  // List
  console.log('\n📋 List URLs');
  await test('GET /api/urls returns list', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls`, { headers });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(Array.isArray(data.urls), 'urls should be an array');
    assert(typeof data.total === 'number', 'total should be a number');
  });

  await test('GET /api/urls requires authentication', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls`);
    assert(resp.status === 401, `Expected 401, got ${resp.status}`);
  });

  // Update
  console.log('\n✏️  Update URL');
  await test('PUT /api/urls/{code} updates URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ campaign: 'updated-test' }),
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const updated = await resp.json();
    assert(updated.campaign === 'updated-test', 'Campaign should be updated');
  });

  // Delete & Restore
  console.log('\n🗑️  Delete and Restore');
  await test('DELETE /api/urls/{code} soft-deletes URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}`, {
      method: 'DELETE',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(data.deleted === true, 'deleted should be true');
  });

  await test('GET /api/urls/deleted shows deleted URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/deleted`, { headers });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    const found = data.urls.find((u) => u.code === testCode);
    assert(found, `Deleted URL ${testCode} should appear in deleted list`);
  });

  await test('POST /api/urls/{code}/restore restores URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}/restore`, {
      method: 'POST',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(data.restored === true, 'restored should be true');
  });

  // Permanent delete (cleanup)
  console.log('\n💀 Permanent Delete');
  await test('DELETE /api/urls/{code} soft-deletes before permanent delete', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}`, {
      method: 'DELETE',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
  });

  await test('DELETE /api/urls/{code}/permanent permanently removes URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}/permanent`, {
      method: 'DELETE',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(data.permanentlyDeleted === true, 'permanentlyDeleted should be true');
  });

  // Summary
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
