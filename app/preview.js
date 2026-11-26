'use strict';
// Dev-server preview proxy (/preview/:port/*) for servers listening on localhost inside the container.
//
// It normally runs on its own port (PREVIEW_PORT, default 7682), so the browser treats previewed pages as a
// different origin from the Agent Hub UI. Pages served by a dev server (and any third-party scripts they load)
// therefore can't call the Agent Hub API with your session. Agent Hub's own cookies are also stripped before
// a request is forwarded, so a dev server never sees them.
const http = require('http');
const net = require('net');

const HUB_COOKIES = new Set(['ah_session', 'ah_preview']);
const PATH_RE = /^\/preview\/(\d+)(\/.*)?$/;

// Remove Agent Hub's cookies from a Cookie header; returns '' when nothing is left.
function stripHubCookies(header) {
  if (!header) return '';
  return String(header).split(';')
    .map((c) => c.trim())
    .filter((c) => c && !HUB_COOKIES.has(c.split('=')[0].trim()))
    .join('; ');
}

function validPort(raw, excluded = []) {
  const p = Number(raw);
  return Number.isInteger(p) && p >= 1024 && p <= 65535 && !excluded.includes(p) ? p : 0;
}

// Keep redirects from the dev server inside /preview/<port>/.
function rewriteLocation(loc, port) {
  if (!loc) return loc;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(loc)) {
    try {
      const u = new URL(loc);
      if (Number(u.port) === port) return `/preview/${port}${u.pathname}${u.search}${u.hash}`;
    } catch {}
    return loc;
  }
  if (loc.startsWith('/') && !loc.startsWith('//') && !loc.startsWith(`/preview/${port}/`)) return `/preview/${port}${loc}`;
  return loc;
}

function upstreamHeaders(reqHeaders, port) {
  const headers = { ...reqHeaders, host: `127.0.0.1:${port}` };
  const cookie = stripHubCookies(reqHeaders.cookie);
  if (cookie) headers.cookie = cookie; else delete headers.cookie;
  return headers;
}

// Forward one HTTP request to 127.0.0.1:<port><upstreamPath>.
function proxyHttp(req, res, port, upstreamPath) {
  const proxyReq = http.request({
    hostname: '127.0.0.1', port, path: upstreamPath || '/', method: req.method, headers: upstreamHeaders(req.headers, port),
  }, (proxyRes) => {
    const outHeaders = { ...proxyRes.headers };
    if (outHeaders.location) outHeaders.location = rewriteLocation(outHeaders.location, port);
    res.writeHead(proxyRes.statusCode || 502, outHeaders);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Nothing is listening on container port ${port} (${err.code || err.message}).`);
    } else res.destroy();
  });
  req.pipe(proxyReq);
}

// Tunnel a WebSocket upgrade (Vite / Next.js HMR, dev servers) to 127.0.0.1:<port><targetPath>.
function proxyUpgrade(req, socket, head, port, targetPath) {
  const upstream = net.connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${targetPath || '/'} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], v = req.rawHeaders[i + 1];
      const lk = k.toLowerCase();
      if (lk === 'host') lines.push(`Host: 127.0.0.1:${port}`);
      else if (lk === 'cookie') { const c = stripHubCookies(v); if (c) lines.push(`${k}: ${c}`); }
      else lines.push(`${k}: ${v}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => { try { socket.destroy(); } catch {} });
  socket.on('error', () => { try { upstream.destroy(); } catch {} });
}

function parsePreviewPath(pathname) {
  const m = String(pathname || '').match(PATH_RE);
  return m ? { port: Number(m[1]), rest: m[2] || '/' } : null;
}

// Removes the one-time ah_pt sign-in parameter from a URL's query string.
function withoutParam(search, name) {
  const sp = new URLSearchParams(search);
  sp.delete(name);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * The standalone preview server (its own port = its own browser origin).
 * opts: {
 *   excludedPorts: number[],
 *   isAuthed(cookies) -> bool         // ah_session or ah_preview cookie is valid
 *   checkHandoff(token) -> bool        // one-time ah_pt token from /api/preview/link
 *   makeCookie() -> string             // value for the ah_preview cookie
 *   cookieTtlSec: number,
 *   parseCookies(req) -> object,
 * }
 */
function createPreviewServer(opts) {
  const deny = (res, code, text) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  };
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return deny(res, 400, 'Bad request'); }
    if (url.pathname === '/healthz') return deny(res, 200, 'ok');
    const pp = parsePreviewPath(url.pathname);
    if (!pp) return deny(res, 404, 'Agent Hub preview server: open previews from the Preview dialog in Agent Hub.');
    const port = validPort(pp.port, opts.excludedPorts);
    if (!port) return deny(res, 400, 'Invalid preview port (must be 1024-65535 and not Agent Hub itself).');

    const handoff = url.searchParams.get('ah_pt');
    if (handoff) {
      if (!opts.checkHandoff(handoff)) return deny(res, 401, 'This preview link has expired. Open it again from Agent Hub.');
      const secure = req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
      // SameSite=None lets the preview load inside Agent Hub's iframe when it's on another site (needs HTTPS).
      const sameSite = secure ? 'None; Secure' : 'Lax';
      res.writeHead(302, {
        'Set-Cookie': `ah_preview=${opts.makeCookie()}; HttpOnly; SameSite=${sameSite}; Path=/preview/; Max-Age=${opts.cookieTtlSec}`,
        Location: `${url.pathname}${withoutParam(url.search, 'ah_pt')}${url.hash}`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      return res.end();
    }
    if (!opts.isAuthed(opts.parseCookies(req))) return deny(res, 401, 'Unauthorized: open this preview from the Preview dialog in Agent Hub.');
    proxyHttp(req, res, port, `${pp.rest}${url.search}`);
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
    const pp = parsePreviewPath(url.pathname);
    const port = pp ? validPort(pp.port, opts.excludedPorts) : 0;
    if (!port) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
    if (!opts.isAuthed(opts.parseCookies(req))) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    proxyUpgrade(req, socket, head, port, `${pp.rest}${url.search}`);
  });
  return server;
}

module.exports = { createPreviewServer, proxyHttp, proxyUpgrade, stripHubCookies, validPort, rewriteLocation, parsePreviewPath, upstreamHeaders };
