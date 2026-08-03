#!/usr/bin/env node
/**
 * An OpenID Connect provider that exists only to be signed in to.
 *
 * Serves real discovery, a real JWKS, and identity tokens signed with a real
 * RSA key generated at startup — so the app's verification runs for actual
 * rather than being stubbed out at the boundary. A test that mocks the
 * signature check is a test that would pass with the signature check deleted.
 *
 * The knobs exist so the unhappy paths can be reached: sign with the wrong
 * key, claim the wrong issuer or audience, backdate the expiry, return a
 * nonce that belongs to a different sign-in.
 *
 * Usage: startMockOidc({ port, clientId }) → { origin, close, options }
 *   options.badSignature | badIssuer | badAudience | expired | wrongNonce
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

function startMockOidc({ port = 3995, clientId = 'ptcg-test' } = {}) {
  const origin = `http://localhost:${port}`;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });   // for forged tokens
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

  // knobs the test turns to reach the failure paths
  const options = { badSignature: false, badIssuer: false, badAudience: false, expired: false, wrongNonce: false };
  // code -> the nonce it was issued against
  const codes = new Map();
  let profile = { sub: 'provider-user-1', email: 'sso@example.test', email_verified: true, preferred_username: 'ssouser', name: 'SSO User' };

  const sign = (claims) => {
    const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key' };
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${b64(header)}.${b64(claims)}`;
    const key = options.badSignature ? other.privateKey : privateKey;
    return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }

    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });

    // consent is not what is under test: approve, and bounce straight back
    if (url.pathname === '/authorize') {
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, url.searchParams.get('nonce'));
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const code = form.get('code');
      if (!codes.has(code)) return json(400, { error: 'invalid_grant' });
      const nonce = codes.get(code);
      codes.delete(code);                                  // one use, like the real thing
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: 'not-used-by-this-app',
        token_type: 'Bearer',
        id_token: sign({
          iss: options.badIssuer ? 'https://somewhere.else.test' : origin,
          aud: options.badAudience ? 'some-other-client' : clientId,
          sub: profile.sub,
          email: profile.email,
          email_verified: profile.email_verified,
          preferred_username: profile.preferred_username,
          name: profile.name,
          nonce: options.wrongNonce ? 'a-nonce-from-another-sign-in' : nonce,
          iat: now,
          exp: options.expired ? now - 3600 : now + 600,
        }),
      });
    }

    json(404, { error: 'not_found' });
  });
  server.on('error', (e) => console.error(`mock oidc could not listen on :${port} — ${e.code}`));
  server.listen(port);

  return {
    origin,
    options,
    setProfile: (p) => { profile = { ...profile, ...p }; },
    reset: () => { for (const k of Object.keys(options)) options[k] = false; },
    close: () => { try { server.close(); } catch { /* already down */ } },
  };
}

module.exports = { startMockOidc };

if (require.main === module) {
  const m = startMockOidc({ port: parseInt(process.env.OIDC_PORT || '3995', 10) });
  console.log('mock oidc on ' + m.origin);
}
