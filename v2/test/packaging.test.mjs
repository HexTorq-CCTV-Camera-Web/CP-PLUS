import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = path.join(root, 'public');
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat();
}

test('browser DOM contract and every local module dependency are packaged', async () => {
  const html = await readFile(path.join(publicDir, 'index.html'), 'utf8');
  const app = await readFile(path.join(publicDir, 'app.mjs'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const [, id] of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(id), `Missing UI element: ${id}`);
  for (const file of await files(publicDir)) {
    if (!file.endsWith('.mjs')) continue;
    const source = await readFile(file, 'utf8');
    for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*|new URL\(\s*)['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), specifier);
      assert.ok(target.startsWith(publicDir + path.sep), `Dependency escapes app: ${specifier}`);
      await access(target);
    }
  }
  for (const [, asset] of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) await access(path.join(publicDir, asset));
});

test('WASM is served correctly and Git/runtime files cannot be downloaded', async t => {
  const app = createApp({ request() { throw Error('No real upstream allowed'); } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const wasm = await fetch(base + '/vendor/hevc-wasm/de265.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer()).slice(0, 4)], [0, 97, 115, 109]);
  for (const file of ['/.env', '/.git/config', '/README.md', '/server.js', '/test/server.test.mjs', '/../v2/server.mjs']) {
    assert.equal((await fetch(base + file)).status, 404, file);
  }
});
