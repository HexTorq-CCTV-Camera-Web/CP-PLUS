import { CameraPlayer } from './player.mjs';
const $ = id => document.getElementById(id);
let cameras = [], selected = null, loginRun = 0, loginTimer, cameraLoad = false;
let noticeTimer;
const expired = new Set(['USER_SESSION_INVALID', 'USER_SESSION_LOSS']);
function notice(message) {
  clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = !message;
  if (message) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 15000);
}
async function api(path, data, { quiet = false } = {}) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(25000),
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (expired.has(result.errorCode) || response.status === 401) {
    if (!quiet) { player.stop(); void showLogin('Your session expired. Scan a new code to reconnect.'); }
    throw new Error('Session expired. Scan a new QR code.');
  }
  if (!response.ok || result.success === false) throw new Error(result.errorMsg || result.error || 'The camera service could not complete this request.');
  return result;
}
const labels = { config: 'Preparing', mqtt: 'Signaling', offer: 'Awaiting answer', ice: 'Connecting',
  playing: 'Live', error: 'Connection failed', interrupted: 'Interrupted', releasing: 'Releasing session', stopped: 'Stopped' };
const player = new CameraPlayer({ api, video: $('video'), onLog(entry) {
  $('log').textContent = player.trace.map(e => `${e.time.slice(11, 19)}  ${e.type}  ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([key]) => !['time', 'type'].includes(key))))}`).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}, onState(state, detail) {
  $('stream-status').textContent = labels[state] || state;
  $('stream-status').className = 'pill ' + state;
  $('stage-overlay').hidden = state === 'playing';
  $('stage-title').textContent = state === 'error' ? 'The camera could not connect.' : state === 'stopped' ? 'Live view stopped.' : 'Connecting to your camera…';
  $('stage-detail').textContent = detail;
  $('stream-detail').textContent = state === 'playing' ? detail + (detail.includes('video only') ? '' : ' · Sound muted by default') : labels[state] || state;
  $('stop').disabled = ['error', 'stopped'].includes(state);
  $('retry').hidden = !['error', 'stopped'].includes(state) || !selected;
  $('fullscreen').disabled = state !== 'playing';
}});
function renderCameras() {
  $('cameras').replaceChildren();
  $('camera-count').textContent = cameras.length;
  $('camera-summary').textContent = `${cameras.length} ${cameras.length === 1 ? 'camera' : 'cameras'} connected · ${cameras.filter(c => c.online).length} online`;
  $('empty-cameras').hidden = cameras.length > 0;
  for (const camera of cameras) {
    const button = document.createElement('button');
    button.className = 'device' + (selected?.devId === camera.devId ? ' selected' : '') + (!camera.online ? ' offline' : '');
    button.setAttribute('aria-pressed', String(selected?.devId === camera.devId));
    const icon = document.createElement('span'); icon.className = 'device-icon'; icon.textContent = '▣'; icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); const title = document.createElement('strong'); title.textContent = camera.name;
    const sub = document.createElement('small'); sub.textContent = `${camera.online ? 'Online' : 'Offline'}${camera.shared ? ' · Shared with you' : ' · Your device'}`;
    text.append(title, sub); const dot = document.createElement('span'); dot.className = 'device-dot';
    button.append(icon, text, dot);
    button.onclick = () => { if (!camera.online) return notice('This camera is offline. Check its power and internet connection.'); void start(camera); };
    $('cameras').append(button);
  }
}
async function start(camera) {
  if (navigator.locks) {
    // Prevent a second v2 tab from opening the same camera concurrently.
    await navigator.locks.request('camera-v2-' + camera.devId, { ifAvailable: true }, async lock => {
      if (!lock) return notice('This camera is already open in another v2 tab. Stop that stream first.');
      const session = await playSelected(camera);
      if (session && player.active === session) await new Promise(resolve => { session.unlock = resolve; });
    });
  } else await playSelected(camera);
}
// Release a held browser lock whenever the player closes, including on failure.
const stopPlayer = player.stop.bind(player);
player.stop = () => { player.active?.unlock?.(); stopPlayer(); };
async function playSelected(camera) {
  selected = camera;
  $('camera-name').textContent = camera.name;
  renderCameras(); notice('');
  return player.start(camera, { quality: $('quality').value });
}
async function loadCameras({ quiet = false } = {}) {
  if (cameraLoad) return false;
  const run = loginRun;
  cameraLoad = true; $('refresh-cams').disabled = true;
  try {
    const result = await api('/api/cams', undefined, { quiet });
    if (run !== loginRun) return false;
    cameras = result.cams || [];
    ++loginRun; clearTimeout(loginTimer);
    $('login').hidden = true; $('workspace').hidden = false; $('signout').hidden = false;
    $('account-status').textContent = 'Account connected';
    renderCameras(); return true;
  } catch (error) { if (!quiet) notice(error.message); return false; }
  finally { cameraLoad = false; $('refresh-cams').disabled = false; }
}
async function showLogin(message = '') {
  player.stop(); selected = null;
  const run = ++loginRun; clearTimeout(loginTimer);
  $('workspace').hidden = true; $('login').hidden = false; $('signout').hidden = true;
  $('account-status').textContent = 'Connect your account';
  $('qr').hidden = true; $('qr').removeAttribute('src'); $('qr-placeholder').hidden = false;
  $('qr-placeholder').textContent = 'Preparing your code…';
  $('qr-status').textContent = message || 'Getting a fresh QR code…';
  $('refresh-qr').disabled = true;
  try {
    const result = await api('/api/qr/start', {}, { quiet: true });
    if (run !== loginRun) return;
    if (!/^data:image\/png;base64,/.test(result.qr || '') || !result.token) throw new Error('The camera service did not return a valid QR image.');
    $('qr').src = result.qr; $('qr').hidden = false; $('qr-placeholder').hidden = true;
    $('qr-status').textContent = message || 'Ready to scan. Confirm the connection in your app.';
    const expires = Date.now() + 180000;
    let polls = 0;
    const poll = async () => {
      if (run !== loginRun) return;
      if (Date.now() > expires) { $('qr-status').textContent = 'This code expired. Generate a new one to continue.'; $('qr').hidden = true; $('qr-placeholder').hidden = false; $('qr-placeholder').textContent = 'Code expired'; return; }
      try {
        await api('/api/qr/poll', { token: result.token }, { quiet: true });
        if (run !== loginRun) return;
        // Only a successful authenticated list response proves login; an empty
        // device list is a valid account, and {domain:{}} is not login success.
        if (++polls % 2 === 0 && await loadCameras({ quiet: true })) return;
      } catch (error) { if (run === loginRun) $('qr-status').textContent = error.message; }
      if (run === loginRun) loginTimer = setTimeout(poll, 2000);
    };
    loginTimer = setTimeout(poll, 2000);
  } catch (error) {
    if (run === loginRun) { $('qr-status').textContent = error.message; $('qr-placeholder').textContent = 'Code unavailable'; }
  } finally { if (run === loginRun) $('refresh-qr').disabled = false; }
}
$('refresh-qr').onclick = () => void showLogin();
$('refresh-cams').onclick = () => void loadCameras();
$('stop').onclick = () => { player.stop(); player.state('stopped', 'Select a camera or retry when you are ready.'); };
$('retry').onclick = () => { if (selected) void start(selected); };
$('quality').onchange = () => {
  if (selected) {
    player.stop();
    void start(selected);
  }
};
$('signout').onclick = async () => {
  player.stop(); ++loginRun; clearTimeout(loginTimer);
  try { await api('/api/logout', {}); await showLogin(); } catch (error) { notice(error.message); }
};
$('fullscreen').onclick = () => $('stage').requestFullscreen().catch(error => notice(error.message));
$('copy-log').onclick = async () => {
  try { await navigator.clipboard.writeText(JSON.stringify({ version: '2.0.0', events: player.trace }, null, 2)); $('copy-log').textContent = 'Copied'; setTimeout(() => { $('copy-log').textContent = 'Copy log'; }, 2000); }
  catch { notice('Copy is unavailable. Select the connection events and copy them manually.'); }
};
addEventListener('pagehide', () => { ++loginRun; clearTimeout(loginTimer); player.stop(); });
function clock() { $('clock').textContent = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
clock(); setInterval(clock, 30000);
try {
  const session = await api('/api/session', undefined, { quiet: true });
  if (!session.authenticated || !await loadCameras({ quiet: true })) await showLogin();
} catch { await showLogin(); }
