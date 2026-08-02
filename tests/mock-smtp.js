#!/usr/bin/env node
/**
 * A mail server that only remembers.
 *
 * Speaks just enough SMTP for nodemailer to believe it and hand over a
 * message, then keeps every one it was given in memory and serves them over a
 * tiny HTTP endpoint so a test can read what the app actually sent — the link
 * in a verification mail is a token the test cannot get any other way.
 *
 * Usage: startMockSmtp({ smtpPort, httpPort }) → { messages, close }
 *   GET http://localhost:<httpPort>/messages  → [{ from, to, body }]
 *   GET http://localhost:<httpPort>/reset     → clears them
 */
'use strict';

const net = require('net');
const http = require('http');

/* The body arrives quoted-printable, which breaks long lines with a trailing
 * `=` — right through the middle of exactly the link a test wants to follow.
 * Join those back up and decode the escapes, so `text` is what a person would
 * actually read. */
function readable(raw) {
  const blank = raw.indexOf('\n\n');
  const body = blank < 0 ? raw : raw.slice(blank + 2);
  return body
    .replace(/=\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function startMockSmtp({ smtpPort = 3997, httpPort = 3996 } = {}) {
  const messages = [];

  const smtp = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let current = { from: null, to: [], body: '' };
    const say = (line) => sock.write(line + '\r\n');
    say('220 mock-smtp ready');

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const nl = buf.indexOf('\r\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ from: current.from, to: current.to.slice(), body: current.body, text: readable(current.body) });
            current = { from: null, to: [], body: '' };
            say('250 stored');
          } else {
            // a leading dot on a body line is doubled by the sender; undo it
            current.body += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          }
          continue;
        }

        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') { say('250-mock-smtp'); say('250 AUTH PLAIN LOGIN'); }
        else if (cmd === 'HELO') say('250 mock-smtp');
        else if (cmd === 'AUTH') say('235 accepted');          // any credentials will do
        else if (cmd === 'MAIL') { current.from = (/<(.*)>/.exec(line) || [])[1] || line.slice(10); say('250 ok'); }
        else if (cmd === 'RCPT') { current.to.push((/<(.*)>/.exec(line) || [])[1] || line.slice(8)); say('250 ok'); }
        else if (cmd === 'DATA') { inData = true; say('354 go ahead'); }
        else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
        else if (cmd === 'RSET') { current = { from: null, to: [], body: '' }; say('250 ok'); }
        else say('250 ok');
      }
    });
    sock.on('error', () => { /* a client hanging up is not news */ });
  });
  // a stale listener from an earlier run should say so, not throw an
  // unhandled 'error' event and take the whole harness down with it
  smtp.on('error', (e) => { console.error(`mock smtp could not listen on :${smtpPort} — ${e.code}`); });
  smtp.listen(smtpPort);

  const web = http.createServer((req, res) => {
    if (req.url.startsWith('/reset')) messages.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(messages));
  });
  web.on('error', (e) => { console.error(`mock smtp inbox could not listen on :${httpPort} — ${e.code}`); });
  web.listen(httpPort);

  return {
    messages,
    close: () => { try { smtp.close(); } catch { /* already down */ } try { web.close(); } catch { /* already down */ } },
  };
}

module.exports = { startMockSmtp };

if (require.main === module) {
  startMockSmtp({
    smtpPort: parseInt(process.env.SMTP_PORT || '3997', 10),
    httpPort: parseInt(process.env.SMTP_HTTP_PORT || '3996', 10),
  });
  console.log('mock smtp on :' + (process.env.SMTP_PORT || 3997));
}
