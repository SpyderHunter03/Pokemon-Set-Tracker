/* A stand-in for api.stripe.com: just enough to prove the portal-session
 * endpoint sends the right thing and handles what comes back. */
'use strict';
const http = require('http');
http.createServer((req, res) => {
  const j = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/v1/billing_portal/sessions' && req.method === 'POST') {
    if (req.headers.authorization !== 'Bearer rk_test_portal_key') return j(401, { error: { message: 'Invalid API key' } });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      if (!/^cus_/.test(p.get('customer') || '')) return j(400, { error: { message: 'No such customer' } });
      j(200, { url: 'https://billing.stripe.com/session/mock_' + p.get('customer') });
    });
    return;
  }
  j(404, { error: { message: 'Unknown' } });
}).listen(3994, () => console.log('mock stripe on :3994'));
