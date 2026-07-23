/* Minimal in-memory S3-compatible mock (enough for publish-images.js tests):
 * PUT /bucket/key, GET /bucket?list-type=2 (with pagination), GET /__store. */
const http = require('http');
const crypto = require('crypto');

const store = new Map(); // key -> { md5, size }
const PAGE = 5; // tiny page size so pagination is genuinely exercised

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/__store') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      count: store.size,
      hasDataIndex: [...store.keys()].some((k) => k.endsWith('/index.json')),
      hasSetData: [...store.keys()].some((k) => k.includes('/sets/')),
      keys: [...store.keys()].slice(0, 5),
    }));
  }

  if (!req.headers.authorization || !req.headers.authorization.startsWith('AWS4-HMAC-SHA256')) {
    res.writeHead(403); return res.end('<Error>missing sigv4 auth</Error>');
  }

  const bucket = parts[0];
  const key = decodeURIComponent(parts.slice(1).join('/'));

  if (req.method === 'PUT' && bucket && key) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      store.set(key, { md5: crypto.createHash('md5').update(body).digest('hex'), size: body.length });
      res.writeHead(200, { ETag: '"' + store.get(key).md5 + '"' });
      res.end();
    });
    return;
  }

  if (req.method === 'GET' && bucket && !key && url.searchParams.get('list-type') === '2') {
    const all = [...store.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const start = parseInt(url.searchParams.get('continuation-token') || '0', 10);
    const page = all.slice(start, start + PAGE);
    const truncated = start + PAGE < all.length;
    const xml = `<?xml version="1.0"?><ListBucketResult>
${page.map(([k, v]) => `<Contents><Key>${k}</Key><ETag>&quot;${v.md5}&quot;</ETag><Size>${v.size}</Size></Contents>`).join('\n')}
<IsTruncated>${truncated}</IsTruncated>
${truncated ? `<NextContinuationToken>${start + PAGE}</NextContinuationToken>` : ''}
</ListBucketResult>`;
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end(xml);
  }

  res.writeHead(404); res.end();
}).listen(3998, () => console.log('mock s3 on :3998'));
