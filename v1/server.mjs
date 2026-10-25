import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const publicDir = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const expired = new Set(['USER_SESSION_INVALID', 'USER_SESSION_LOSS']);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
export function createApp({ origin = 'https://web.ezykam.com', request = fetch } = {}) {
  const sessions = new Map();
  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  async function body(req) {
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (Buffer.byteLength(data) > 16384) throw Object.assign(new Error('Request too large'), { status: 413 });
    }
    try { return data ? JSON.parse(data) : {}; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  async function upstream(session, url, data) {
    const response = await request(origin + url, { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest',
        'Cache-Control': 'no-cache', Pragma: 'no-cache', 'cloud-type': 'cpplus',
        'cpplus-region-code': session.region || '', 'public-region-code': '',
        'csrf-token': session.cookies.get('csrf-token') || '', 's-sid': session.cookies.get('s-sid') || '',
        cookie: [...session.cookies].map(([key, value]) => key + '=' + value).join('; '),
        origin, referer: origin + '/login' },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]; const equals = pair.indexOf('=');
      if (equals < 1) continue;
      const key = pair.slice(0, equals); const value = pair.slice(equals + 1);
      if (!value || /max-age=0(?:;|$)/i.test(cookie)) session.cookies.delete(key);
      else session.cookies.set(key, value);
    }
    let result;
    try { result = await response.json(); } catch { throw Object.assign(new Error('The camera service returned an invalid response.'), { status: 502 }); }
    if (expired.has(result.errorCode)) session.authenticated = false;
    return result;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
        const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
        const target = path.resolve(publicDir, '.' + relative);
        if (!target.startsWith(publicDir + path.sep) && target !== path.join(publicDir, 'index.html')) return send(res, 404, { error: 'Not found' });
        try {
          const data = await readFile(target);
          res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
          return res.end(req.method === 'HEAD' ? undefined : data);
        } catch { return send(res, 404, { error: 'Not found' }); }
      }
      // This proxy's cookies belong to one browser session, never a global jar.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return send(res, 403, { error: 'Origin not allowed' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Origin not allowed' });
      const id = /(?:^|;\s*)cpplus_v1_session=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
      let session = sessions.get(id);
      if (!session) {
        const key = randomUUID();
        session = { cookies: new Map(), touched: Date.now(), authenticated: false };
        sessions.set(key, session);
        res.setHeader('Set-Cookie', `cpplus_v1_session=${key}; HttpOnly; SameSite=Strict; Path=/${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
      }
      session.touched = Date.now();
      for (const [key, value] of sessions) if (Date.now() - value.touched > 24 * 3600000) sessions.delete(key);
      const forward = result => send(res, expired.has(result.errorCode) ? 401 : result.success === false ? 502 : 200, result);
      if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, version: '1.1.0' });
      if (url.pathname === '/api/session' && req.method === 'GET') return send(res, 200, { authenticated: session.authenticated });
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        session.cookies.clear(); session.authenticated = false;
        return send(res, 200, { success: true });
      }
      if (url.pathname === '/api/qr/start' && req.method === 'POST') {
        const q = await upstream(session, '/api/customized/qrcode');
        if (!q.success || !q.result?.token) return forward(q);
        const exchange = await upstream(session, '/api/login/exchange', { url: 'tuyaSmart--qrLogin?token=' + q.result.token });
        if (!exchange.success) return forward(exchange);
        return send(res, 200, { qr: exchange.result, token: q.result.token });
      }
      if (url.pathname === '/api/qr/poll' && req.method === 'POST') {
        const data = await body(req);
        if (typeof data.token !== 'string' || !data.token) return send(res, 400, { error: 'QR token required' });
        return forward(await upstream(session, '/api/customized/login/poll', { token: data.token }));
      }
      if (url.pathname === '/api/cams' && req.method === 'GET') {
        const [homes, shares] = await Promise.all([
          upstream(session, '/api/customized/common/homeList'), upstream(session, '/api/customized/playback/shareList')
        ]);
        const authError = [homes, shares].find(result => expired.has(result.errorCode));
        if (authError) return forward(authError);
        if (!homes.success) return forward(homes);
        if (!shares.success) return forward(shares);
        const list = new Map();
        const push = (device, shared) => {
          const devId = device.devId || device.dev_id;
          if (!devId) return;
          list.set(devId, { devId, name: device.name || devId, iconUrl: device.iconUrl,
            online: device.cloudOnline !== false, shared, productId: device.productId, uuid: device.uuid });
        };
        for (const home of Array.isArray(homes.result) ? homes.result : []) {
          for (const device of home.devices || home.deviceList || []) push(device, false);
        }
        const shared = Array.isArray(shares.result) ? shares.result : [
          ...(shares.result?.securityWebCShareInfoList || []), ...(shares.result?.securityWebBShareInfoList || [])
        ];
        for (const device of shared) push(device, true);
        session.authenticated = true;
        return send(res, 200, { homes: homes.result, cams: [...list.values()] });
      }
      if (url.pathname === '/api/msid' && req.method === 'GET') return forward(await upstream(session, '/api/hybrid/getMsid'));
      if (url.pathname === '/api/rtc' && req.method === 'POST') {
        const data = await body(req);
        if (typeof data.devId !== 'string' || !data.devId || !/^[a-f0-9]{32}$/i.test(data.clientTraceId || '')) return send(res, 400, { error: 'Device ID and a 32-character clientTraceId required' });
        return forward(await upstream(session, '/api/customized/rtc/config', { devId: data.devId, clientTraceId: data.clientTraceId }));
      }
      send(res, 404, { error: 'Not found' });
    } catch (error) {
      send(res, error.status || 502, { success: false, error: error.name === 'TimeoutError' ? 'The camera service timed out.' : error.message });
    }
  });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8000);
  const server = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Choose another PORT.` : error.message); process.exitCode = 1; });
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`CPPlus v1: http://localhost:${port}`));
}
