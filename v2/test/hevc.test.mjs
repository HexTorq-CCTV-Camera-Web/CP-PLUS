import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FragmentAssembler, HevcPlayer, mp4Mime } from '../public/hevc.mjs';
import { streamConfig, offerMessage } from '../public/protocol.mjs';
import { annexB, parameterSets } from '../public/hevc-software.mjs';

const fragment = (segment, count, sequence, bytes) => new Uint8Array([segment >> 8, segment & 255, count, sequence, ...bytes]).buffer;
test('HD selects H265 main stream, wire zero, and enables the data channel', () => {
  const config = { id: 'camera', auth: 'fresh', motoId: 'fresh', p2pConfig: { ices: [{ urls: 'stun:example.test' }] },
    skill: { videos: [{ streamType: 2, codecType: 4, width: 2304, height: 1296 }, { streamType: 4, codecType: 2, width: 640, height: 360 }] } };
  const hd = streamConfig(config, { quality: 'hd' });
  assert.equal(hd.stream.width, 2304); assert.equal(hd.hevc, true);
  assert.equal(offerMessage('sdp', config, hd).stream_type, 0);
  assert.equal(offerMessage('sdp', config, hd).datachannel_enable, true);
  assert.equal(streamConfig(config).stream.width, 640);
});
test('MP4 file brands are removed from the MediaSource codec check', () => {
  assert.equal(mp4Mime({ mime: 'video/mp4; codecs="hvc1.1.6.L120.90"; profiles="iso6,isom"',
    tracks: [{ codec: 'hvc1.1.6.L120.90' }] }), 'video/mp4; codecs="hvc1.1.6.L120.90"');
  assert.throws(() => mp4Mime({ tracks: [] }), /did not identify/);
});
test('four-byte HD framing is removed and multi-part MP4 segments reassemble', () => {
  const assembler = new FragmentAssembler();
  assert.deepEqual([...assembler.push(fragment(65535, 1, 1, [1, 2]))], [1, 2]);
  assert.equal(assembler.push(fragment(0, 3, 1, [3, 4])), null);
  assert.equal(assembler.push(fragment(0, 3, 2, [5, 6])), null);
  assert.deepEqual([...assembler.push(fragment(0, 3, 3, [7, 8]))], [3, 4, 5, 6, 7, 8]);
  assert.throws(() => assembler.push(fragment(2, 3, 2, [1])), /incomplete/);
  assert.deepEqual([...assembler.push(fragment(3, 1, 1, [9]))], [9]);
});
function environment({ supported = true, Software } = {}) {
  const errors = [], logs = [], sent = [], appended = [], revoked = [];
  const channel = { readyState: 'open', send: text => sent.push(JSON.parse(text)), close() { this.closed = true; } };
  const video = Object.assign(new EventTarget(), { srcObject: {}, currentTime: 0, buffered: { length: 0 }, play: async () => {}, load() {}, removeAttribute() {} });
  let source;
  class Media extends EventTarget {
    static isTypeSupported(mime) { return supported && !mime.includes('profiles='); }
    constructor() { super(); this.readyState = 'closed'; source = this; }
    addSourceBuffer(mime) {
      this.mime = mime;
      return this.buffer = Object.assign(new EventTarget(), { updating: false, buffered: { length: 0 },
        appendBuffer(chunk) { this.updating = true; appended.push([...chunk]); } });
    }
  }
  const parser = { appendBuffer(buffer) { this.onReady({ mime: 'video/mp4; codecs="hvc1"; profiles="iso6,isom"', tracks: [{ codec: 'hvc1', video: { width: 2304, height: 1296 } }] }); }, stop() { this.stopped = true; } };
  const hd = new HevcPlayer({ peer: { createDataChannel(label, options) { assert.equal(label, 'fmp4Stream'); assert.equal(options.maxRetransmits, 5); return channel; } },
    video, onError: error => errors.push(error), onLog: (type, data) => logs.push({ type, data }), Media,
    mp4box: { createFile: () => parser }, urls: { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) }, ...(Software ? { Software } : {}) });
  return { hd, channel, video, errors, sent, appended, revoked, source: () => source };
}
test('HD codec handshake requests fmp4, acknowledges recv, and queues MSE appends', async () => {
  const env = environment(); const { hd, sent, video, appended } = env;
  await hd.message(JSON.stringify({ type: 'codec', msg: 'hvc1.1.6.L120.90' }));
  await hd.message(JSON.stringify({ type: 'recv', msg: '' }));
  assert.deepEqual(sent, [{ type: 'start', msg: 'fmp4' }, { type: 'complete', msg: '' }]);
  await hd.message(fragment(0, 1, 1, [10, 11]));
  assert.equal(video.srcObject, null); assert.equal(video.src, 'blob:test');
  const source = env.source(); source.readyState = 'open'; source.dispatchEvent(new Event('sourceopen'));
  assert.deepEqual(appended, [[10, 11]]);
  await hd.message(fragment(1, 1, 1, [12, 13]));
  assert.deepEqual(appended, [[10, 11]], 'Must not append while SourceBuffer is updating');
  source.buffer.updating = false; source.buffer.dispatchEvent(new Event('updateend'));
  assert.deepEqual(appended, [[10, 11], [12, 13]]);
  hd.close(); assert.deepEqual(env.revoked, ['blob:test']); assert.equal(env.channel.closed, true);
  await hd.message(fragment(2, 1, 1, [14])); assert.equal(hd.queue.length, 0);
});
test('unsupported native HEVC retains MP4 transport and selects software decoding', async () => {
  let decoder;
  class Software { constructor(options) { decoder = this; this.options = options; this.received = []; } push(chunk, offset) { this.received.push({ chunk: [...chunk], offset }); } close() { this.closed = true; } }
  const { hd, sent, errors } = environment({ supported: false, Software });
  await hd.message(JSON.stringify({ type: 'codec', msg: 'hvc1' }));
  assert.deepEqual(sent, [{ type: 'start', msg: 'fmp4' }]);
  await hd.message(fragment(0, 1, 1, [1, 2]));
  assert.ok(decoder); assert.equal(hd.parser, null);
  await hd.message(fragment(1, 1, 1, [3, 4]));
  assert.deepEqual(decoder.received, [{ chunk: [3, 4], offset: 2 }]);
  assert.deepEqual(errors, []); hd.close(); assert.equal(decoder.closed, true);
});
test('software decoder converts MP4 NAL lengths to Annex B and preserves HEVC parameter sets', () => {
  assert.deepEqual([...annexB(new Uint8Array([0, 0, 0, 2, 64, 1, 0, 0, 0, 3, 66, 2, 3]), 4)], [0, 0, 0, 1, 64, 1, 0, 0, 0, 1, 66, 2, 3]);
  assert.deepEqual([...parameterSets([new Uint8Array([64, 1])])], [0, 0, 0, 1, 64, 1]);
  assert.throws(() => annexB(new Uint8Array([0, 0, 0, 6, 1]), 4), /Invalid H265/);
});
test('an unexpected raw-frame response is rejected instead of feeding RTP to MediaSource', async () => {
  const { hd, sent, errors } = environment();
  await hd.message(JSON.stringify({ type: 'recv', msg: '{"video":{"ssrc":123}}' }));
  assert.equal(sent[0].type, 'complete'); assert.match(errors[0], /software-decoder/); hd.close();
});
