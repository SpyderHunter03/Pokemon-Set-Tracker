/* A minimal stand-in for the TCG Card API: a token gate in front of the mock
 * bucket's published catalog. Just enough behaviour to prove the tracker is
 * an honest API client — the real refusal semantics (401 no/bad token, 403
 * revoked, 402 allowance spent but the free manifest still answering) live
 * in the API's own repository and its own test suite.
 */
'use strict';

const http = require('http');

const GOOD = 'ptcg_live_' + 'a'.repeat(40);
const REVOKED = 'ptcg_live_' + 'b'.repeat(40);
const SPENT = 'ptcg_live_' + 'c'.repeat(40);
const UPSTREAM = 'http://localhost:3998/cards';   // the mock S3's published master

http.createServer(async (req, res) => {
  const j = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const pass = async (upstreamPath, type) => {
    const r = await fetch(UPSTREAM + upstreamPath);
    if (!r.ok) return j(r.status, { error: 'upstream said ' + r.status });
    res.writeHead(200, { 'content-type': type });
    res.end(Buffer.from(await r.arrayBuffer()));
  };
  try {
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (tok === REVOKED) return j(403, { error: 'This token has been revoked' });
    if (tok !== GOOD && tok !== SPENT) return j(401, { error: 'A token is required' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v1/catalog.json') return pass('/catalog.json', 'application/json');
    if (url.pathname === '/v1/catalog.db') {
      if (tok === SPENT) return j(402, { error: 'Monthly allowance spent' });
      return pass('/catalog.db', 'application/octet-stream');
    }
    if (url.pathname === '/v1/scan-index') {
      return pass('/' + (url.searchParams.get('lang') || 'en') + '/scan-index.json', 'application/json');
    }
    return j(404, { error: 'Unknown endpoint' });
  } catch (e) {
    return j(500, { error: e.message });
  }
}).listen(3996, () => console.log('mock card API on :3996'));
