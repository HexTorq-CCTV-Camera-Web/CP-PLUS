// Runs without npm dependencies. Copies one app at a time outside the workspace.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'cpplus-standalone-'));
const children = new Set();
async function run(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
  children.add(child);
  const [code] = await once(child, 'exit');
  children.delete(child);
  assert.equal(code, 0, `Command failed: node ${args.join(' ')}`);
}
async function smoke(cwd, entry, version, cookieName) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [entry], {
    cwd, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  try {
    let response;
    for (let tries = 0; tries < 100; tries++) {
      assert.equal(child.exitCode, null, `Startup failed: ${output}`);
      try { response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(response, `Startup timed out: ${output}`);
    assert.deepEqual(await response.json(), { ok: true, version });
    assert.ok(response.headers.get('set-cookie').startsWith(cookieName + '='));
    for (const asset of ['/', '/app.mjs', '/player.mjs', '/styles.css', '/vendor/mqtt.min.js', '/vendor/hevc-wasm/de265.wasm']) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${asset}`)).status, 200, asset);
    }
    console.log(`${path.basename(cwd)} ${entry}: isolated startup, session cookie and assets OK`);
  } finally {
    child.kill(); await exited; children.delete(child);
  }
}
try {
  for (const [name, version] of [['v1', '1.1.0'], ['v2', '2.0.0']]) {
    const target = path.join(temp, name);
    await cp(path.join(root, name), target, { recursive: true,
      filter: source => !['node_modules', '.git', '.env'].includes(path.basename(source)) });
    await run(['--test', 'test/*.test.mjs'], target);
    await smoke(target, 'server.mjs', version, `cpplus_${name}_session`);
    if (name === 'v1') await smoke(target, 'server.js', version, 'cpplus_v1_session');
  }
  console.log('Both apps run independently outside the original workspace. No real camera calls made.');
} finally {
  for (const child of children) child.kill();
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('cpplus-standalone-'));
  await rm(resolved, { recursive: true, force: true });
}
