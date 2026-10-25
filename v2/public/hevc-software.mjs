export function annexB(sample, lengthSize) {
  const bytes = sample instanceof Uint8Array ? sample : new Uint8Array(sample);
  const parts = []; let size = 0;
  for (let offset = 0; offset < bytes.length;) {
    if (offset + lengthSize > bytes.length) throw new Error('Incomplete H265 sample.');
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + bytes[offset++];
    if (!length || offset + length > bytes.length) throw new Error('Invalid H265 NAL length.');
    parts.push(bytes.subarray(offset, offset + length)); size += length + 4; offset += length;
  }
  return parameterSets(parts, size);
}
export function parameterSets(parts, size = parts.reduce((sum, part) => sum + part.length + 4, 0)) {
  const result = new Uint8Array(size); let offset = 0;
  for (const part of parts) { result.set([0, 0, 0, 1], offset); offset += 4; result.set(part, offset); offset += part.length; }
  return result;
}

export class SoftwareHevc {
  constructor({ parser, info, video, onFrame, onError, onLog, WorkerClass = globalThis.Worker }) {
    if (!WorkerClass || !globalThis.HTMLCanvasElement?.prototype.transferControlToOffscreen) throw new Error('This browser cannot run the HD software renderer. SD remains available.');
    Object.assign(this, { parser, video, onFrame, onError, onLog });
    this.closed = false; this.ready = false; this.pending = []; this.pendingBytes = 0; this.inflight = 0;
    const track = info.tracks.find(track => /^(hvc1|hev1)/i.test(track.codec));
    if (!track) throw new Error('No H265 video track found in the camera MP4.');
    this.trackId = track.id;
    const entry = parser.getTrackById(track.id)?.mdia?.minf?.stbl?.stsd?.entries?.[0];
    const hvcc = entry?.hvcC;
    if (!hvcc?.nalu_arrays?.length) throw new Error('The camera did not send H265 decoder parameter sets.');
    this.lengthSize = hvcc.lengthSizeMinusOne + 1;
    const sets = hvcc.nalu_arrays.flatMap(array => array.map(nal => nal.data));
    this.config = parameterSets(sets);
    this.canvas = document.createElement('canvas'); this.canvas.className = 'hd-canvas';
    this.canvas.setAttribute('aria-label', 'HD live camera video');
    video.parentNode.insertBefore(this.canvas, video);
    video.hidden = true; video.srcObject = null;
    this.worker = new WorkerClass(new URL('./hevc-worker.mjs', import.meta.url), { type: 'module' });
    this.worker.onerror = () => { if (!this.closed) onError('HD software decoder failed to load. Copy the connection log.'); };
    this.worker.onmessage = event => {
      if (this.closed) return;
      const message = event.data;
      if (message.type === 'ready') {
        this.ready = true;
        this.worker.postMessage({ type: 'config', data: this.config.buffer }, [this.config.buffer]);
        onLog('hd-software-ready'); this.flush();
      } else if (message.type === 'frame') {
        onFrame({ width: message.width, height: message.height, software: true });
        if (message.frames === 1) onLog('hd-software-first-frame', { width: message.width, height: message.height });
      } else if (message.type === 'consumed') {
        this.inflight--; this.pendingBytes -= message.bytes; this.flush();
      } else if (message.type === 'error') onError(message.detail);
    };
    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
    parser.onSamples = (id, _user, samples) => {
      if (this.closed || id !== this.trackId) return;
      for (const sample of samples) {
        const bytes = annexB(sample.data, this.lengthSize);
        this.pending.push(bytes); this.pendingBytes += bytes.byteLength;
        parser.releaseUsedSamples(id, sample.number + 1);
      }
      if (this.pendingBytes > 32 * 1024 * 1024 || this.pending.length > 180) return onError('The HD software decoder fell behind. Select SD or use a faster device.');
      this.flush();
    };
    parser.setExtractionOptions(track.id, null, { nbSamples: 1, rapAlignment: false });
    parser.start();
    onLog('hd-software-selected', { codec: track.codec, audio: 'video only' });
  }
  flush() {
    while (!this.closed && this.ready && this.pending.length && this.inflight < 4) {
      const bytes = this.pending.shift(); this.inflight++;
      this.worker.postMessage({ type: 'sample', data: bytes.buffer }, [bytes.buffer]);
    }
  }
  push(chunk, offset) {
    if (this.closed) return;
    const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    buffer.fileStart = offset; this.parser.appendBuffer(buffer);
  }
  close() {
    this.closed = true; this.parser.stop(); this.parser.onSamples = null;
    this.worker.terminate(); this.canvas.remove(); this.video.hidden = false;
    this.pending = []; this.pendingBytes = 0;
  }
}
