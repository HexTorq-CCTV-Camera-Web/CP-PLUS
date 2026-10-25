import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

async function server(t, request) {
  const app = createApp({ request }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  return 'http://127.0.0.1:' + app.address().port;
}
const json = (data, cookies = []) => { const headers = new Headers({ 'Content-Type': 'application/json' }); for (const c of cookies) headers.append('Set-Cookie', c); return new Response(JSON.stringify(data), { headers }); };
test('only public assets are served; history and server source are private', async t => {
  const base = await server(t, () => { throw Error('Unexpected upstream call'); });
  for (const asset of ['/', '/app.mjs', '/styles.css', '/player.mjs', '/protocol.mjs', '/vendor/mqtt.min.js']) assert.equal((await fetch(base + asset)).status, 200, asset);
  for (const file of ['/web-camera.json', '/server.mjs', '/package.json', '/%2e%2e%5cserver.mjs']) assert.equal((await fetch(base + file)).status, 404, file);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});
test('upstream cookies stay isolated by browser and required cookie headers are forwarded', async t => {
  let count = 0; const calls = [];
  const base = await server(t, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/qrcode')) return json({ success: true, result: { token: 'qr-' + ++count } }, ['s-sid=account-' + count + '; Path=/', 'csrf-token=csrf-' + count + '; Path=/']);
    if (url.endsWith('/exchange')) return json({ success: true, result: 'data:image/png;base64,test' });
    return json({ success: true, result: { msid: 'fresh', password: 'fresh' } });
  });
  const first = await fetch(base + '/api/qr/start', { method: 'POST' }); const firstCookie = first.headers.get('set-cookie').split(';')[0];
  await first.json();
  const second = await fetch(base + '/api/qr/start', { method: 'POST' }); const secondCookie = second.headers.get('set-cookie').split(';')[0]; await second.json();
  await fetch(base + '/api/msid', { headers: { cookie: firstCookie } });
  assert.equal(calls.at(-1).options.headers['s-sid'], 'account-1');
  assert.equal(calls.at(-1).options.headers['csrf-token'], 'csrf-1');
  await fetch(base + '/api/msid', { headers: { cookie: secondCookie } });
  assert.equal(calls.at(-1).options.headers['s-sid'], 'account-2');
});
test('camera list accepts shared arrays and both object lists, including zero cameras', async t => {
  let shares = [{ devId: 'shared', name: '<img onerror=alert(1)>', cloudOnline: true }];
  const base = await server(t, async url => json({ success: true, result: url.endsWith('/homeList') ? [] : shares }));
  let result = await (await fetch(base + '/api/cams')).json(); assert.equal(result.cams[0].shared, true);
  assert.equal(result.cams[0].name, '<img onerror=alert(1)>');
  shares = { securityWebCShareInfoList: [{ devId: 'c' }], securityWebBShareInfoList: [{ devId: 'b' }] };
  result = await (await fetch(base + '/api/cams')).json(); assert.equal(result.cams.length, 2);
  shares = []; result = await (await fetch(base + '/api/cams')).json(); assert.deepEqual(result.cams, []);
});
test('expired upstream sessions are returned as 401 instead of an empty camera list', async t => {
  const base = await server(t, async () => json({ success: false, errorCode: 'USER_SESSION_INVALID' }));
  const response = await fetch(base + '/api/cams'); assert.equal(response.status, 401);
  assert.equal((await response.json()).errorCode, 'USER_SESSION_INVALID');
});
test('invalid JSON, invalid stream requests, and cross-origin access are rejected', async t => {
  const base = await server(t, () => { throw Error('Should not contact upstream'); });
  assert.equal((await fetch(base + '/api/rtc', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(base + '/api/rtc', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await fetch(base + '/api/msid', { headers: { Origin: 'https://other.test' } })).status, 403);
});
