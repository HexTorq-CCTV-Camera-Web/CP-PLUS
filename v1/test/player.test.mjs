import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CameraPlayer } from '../public/player.mjs';
import { streamConfig, offerMessage, envelope, redact } from '../public/protocol.mjs';

const config = { id: 'device-test', auth: 'fresh-auth', motoId: 'fresh-moto', protocolVersion: '2.3',
  p2pConfig: { ices: [{ urls: 'stun:example.test:3478' }, { urls: 'turn:example.test:3478', username: 'fresh-user', credential: 'fresh-secret', ttl: 36000 }] },
  skill: JSON.stringify({ videos: [{ streamType: 2, codecType: 4, width: 2304 }, { streamType: 4, codecType: 2, width: 640, height: 360 }] }) };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
globalThis.MediaStream = class { constructor() { this.tracks = []; } getTracks() { return this.tracks; } addTrack(track) { this.tracks.push(track); } };
class Peer {
  constructor(options) { this.options = options; this.transceivers = []; this.added = []; }
  addTransceiver(type, options) { this.transceivers.push({ type, ...options }); }
  async createOffer() { return { type: 'offer', sdp: 'original-offer' }; }
  async setLocalDescription(offer) { this.localDescription = { ...offer, sdp: 'gathered-offer' }; }
  async setRemoteDescription(answer) { await delay(10); this.remoteDescription = answer; }
  async addIceCandidate(candidate) { assert.ok(this.remoteDescription, 'Remote description must precede candidates'); this.added.push(candidate); }
  close() { this.closed = true; }
}
class Mqtt extends EventEmitter {
  constructor() { super(); this.sent = []; this.connected = true; }
  subscribe(topic, options, done) { this.topic = topic; done(null, [{ topic, qos: 1 }]); }
  publish(topic, payload, options, done) { this.sent.push({ topic, packet: JSON.parse(payload), options }); done?.(); }
  end() { this.closed = true; }
}
function setup(options = {}) {
  const socket = new Mqtt(); const states = []; const calls = [];
  const player = new CameraPlayer({ video: { play: async () => {} }, onState: (name, detail) => states.push({ name, detail }), onLog: () => {}, Peer,
    mqtt: { connect: () => socket }, makeId: () => '1'.repeat(32),
    api: async (url, body) => { calls.push({ url, body }); return { success: true, result: url === '/api/rtc' ? config : { msid: 'fresh-msid', password: 'fresh-password' } }; },
    ...options });
  const packet = (type, msg, id = '1'.repeat(32)) => Buffer.from(JSON.stringify({ protocol: 302, data: { header: { sessionid: id, from: config.id, type }, msg } }));
  return { player, socket, states, calls, packet };
}
test('H264 selection translates internal substream 4 into wire stream 1', () => {
  const stream = streamConfig(config); const msg = offerMessage('sdp', config, stream);
  assert.equal(stream.stream.streamType, 4); assert.equal(msg.stream_type, 1);
  assert.equal(msg.datachannel_enable, false); assert.equal(msg.token[1].ttl, 36000);
  assert.equal(stream.iceServers[1].ttl, undefined);
  assert.throws(() => streamConfig({ ...config, skill: { videos: [{ streamType: 2, codecType: 4 }] } }), /no advertised H264/);
});
test('signaling matches verified topic, shared trace ID, raw offer SDP, and candidate mode', async t => {
  const { player, socket, calls } = setup(); t.after(() => player.stop());
  const s = await player.start({ devId: config.id });
  s.peer.onicecandidate({ candidate: { candidate: 'candidate:1 typ relay' } });
  socket.emit('connect');
  const offer = socket.sent[0];
  assert.equal(calls[0].body.clientTraceId, offer.packet.data.header.sessionid);
  assert.equal(offer.topic, '/av/moto/fresh-moto/u/device-test');
  assert.equal(offer.packet.data.msg.stream_type, 1);
  assert.equal(offer.packet.data.msg.sdp, 'original-offer');
  assert.equal(offer.packet.data.header.tid, undefined);
  assert.equal(offer.options.qos, 1);
  assert.equal(socket.sent[1].packet.data.msg.mode, 'webrtc');
  assert.match(socket.sent[1].packet.data.msg.candidate, /^a=candidate:/);
  assert.equal(s.answered, false, 'Candidates must be sent before an answer');
  assert.equal(s.peer.transceivers[0].type, 'audio');
});
test('buffers early remote ICE, serializes answer handling, and rejects other sessions', async t => {
  const { player, socket, packet, states } = setup(); t.after(() => player.stop());
  const s = await player.start({ devId: config.id }); socket.emit('connect');
  socket.emit('message', '', packet('answer', { sdp: 'wrong' }, 'different'));
  socket.emit('message', '', packet('candidate', { candidate: 'a=candidate:early\r\n' }));
  socket.emit('message', '', packet('answer', { sdp: 'real-answer' }));
  socket.emit('message', '', packet('candidate', { candidate: 'a=candidate:later\r\n' }));
  await s.queue;
  assert.equal(s.peer.remoteDescription.sdp, 'real-answer');
  assert.deepEqual(s.peer.added.map(c => c.candidate), ['candidate:early', 'candidate:later']);
  assert.equal(states.at(-1).name, 'ice');
  assert.ok(!states.some(s => s.name === 'playing'), 'An answer is not proof of rendered video');
  player.video.videoWidth = 640; player.video.onplaying();
  assert.equal(states.at(-1).name, 'playing');
  player.stop(); assert.equal(socket.sent.at(-1).packet.protocol, 312);
  assert.equal(socket.sent.at(-1).packet.data.header.type, 'disconnect');
  assert.equal(socket.closed, true);
});
test('stopping while config is pending prevents a stale request from opening MQTT', async () => {
  let resolve; let opened = 0;
  const { player } = setup({ api: () => new Promise(done => { resolve = done; }), mqtt: { connect: () => { opened++; } } });
  const pending = player.start({ devId: config.id });
  player.stop(); resolve({ success: true, result: config }); await pending;
  assert.equal(opened, 0); assert.equal(player.active, null);
});
test('a silent camera stops retrying after the answer timeout', async () => {
  const { player, socket, states } = setup({ offerTimeout: 15 });
  const s = await player.start({ devId: config.id }); socket.emit('connect'); await delay(40);
  assert.equal(states.at(-1).name, 'error'); assert.equal(s.peer.closed, true); assert.equal(socket.closed, true);
  assert.equal(player.active, null);
});
test('an answer without rendered frames times out instead of reporting live', async () => {
  const { player, socket, packet, states } = setup({ frameTimeout: 15 });
  const s = await player.start({ devId: config.id }); socket.emit('connect');
  socket.emit('message', '', packet('answer', { sdp: 'answer-without-video' }));
  await s.queue; await delay(40);
  assert.equal(states.at(-1).name, 'error');
  assert.match(states.at(-1).detail, /no video rendered/);
  assert.equal(player.active, null);
  assert.ok(!states.some(s => s.name === 'playing'));
});
test('logs redact camera secrets and SDP', () => {
  assert.deepEqual(redact({ auth: 'secret', password: 'secret', credential: 'secret', sdp: 'secret', nested: { token: 'secret' }, state: 'ok' }),
    { auth: '[redacted]', password: '[redacted]', credential: '[redacted]', sdp: '[redacted]', nested: { token: '[redacted]' }, state: 'ok' });
  assert.equal(envelope({ id: 'id', msid: 'msid', target: 'target', pv: '2.3', motoId: 'moto' }, 'offer', {}, 123).t, 123);
});
test('HD uses audio sendonly plus a decoder data channel and releases the decoder on stop', async () => {
  let decoder;
  class HdPlayer { constructor(options) { decoder = this; this.options = options; } close() { this.closed = true; } }
  const { player, socket } = setup({ HdPlayer });
  const s = await player.start({ devId: config.id }, { quality: 'hd' });
  socket.emit('connect');
  assert.deepEqual(s.peer.transceivers, [{ type: 'audio', direction: 'sendonly' }]);
  assert.equal(socket.sent[0].packet.data.msg.stream_type, 0);
  assert.equal(socket.sent[0].packet.data.msg.datachannel_enable, true);
  player.stop(); assert.equal(decoder.closed, true);
});
