import { SoftwareHevc } from './hevc-software.mjs';
// EzyKam V3 HD: fmp4Stream data channel, codec/start/recv/complete handshake,
// then MP4 fragments prefixed by a four-byte segment/fragment header.
export class FragmentAssembler {
  constructor() { this.reset(); }
  reset() { this.segment = null; this.parts = []; this.count = 0; this.bytes = 0; }
  push(buffer) {
    const data = new Uint8Array(buffer);
    if (data.length < 5) throw new Error('Invalid HD fragment header.');
    const segment = data[0] * 256 + data[1], count = data[2], sequence = data[3];
    const payload = data.slice(4);
    if (!count) throw new Error('Invalid HD fragment count.');
    if (count === 1) { this.reset(); return payload; }
    if (sequence === 1) { this.reset(); this.segment = segment; this.count = count; }
    if (this.segment !== segment || this.count !== count || sequence !== this.parts.length + 1) {
      this.reset(); throw new Error('HD fragments arrived incomplete. Stop and retry the camera.');
    }
    this.parts.push(payload); this.bytes += payload.length;
    if (this.bytes > 16 * 1024 * 1024) { this.reset(); throw new Error('HD segment exceeded the buffer limit.'); }
    if (sequence !== count) return null;
    const result = new Uint8Array(this.bytes); let offset = 0;
    for (const part of this.parts) { result.set(part, offset); offset += part.length; }
    this.reset(); return result;
  }
}

export function mp4Mime(info) {
  const codecs = (info.tracks || []).map(track => track.codec).filter(Boolean);
  if (!codecs.length) throw new Error('The camera MP4 metadata did not identify a video codec.');
  // MP4Box info.mime includes file-brand `profiles`, which is not a decoder
  // profile and can make MediaSource reject an otherwise supported codec.
  return `video/mp4; codecs="${[...new Set(codecs)].join(',')}"`;
}

export class HevcPlayer {
  constructor({ peer, video, onError, onLog, onFrame = () => {}, Media = globalThis.MediaSource, mp4box = globalThis.MP4Box, urls = globalThis.URL, Software = SoftwareHevc }) {
    if (!Media || !mp4box) throw new Error('HD decoding is unavailable in this browser. Select SD to keep watching.');
    Object.assign(this, { video, onError, onLog, onFrame, Media, urls, Software });
    this.fragments = new FragmentAssembler(); this.queue = []; this.bytes = 0;
    this.fileOffset = 0; this.closed = false; this.parsed = false;
    this.parser = mp4box.createFile();
    this.parser.onReady = info => {
      if (this.closed) return;
      this.parsed = true;
      const mime = mp4Mime(info);
      const supported = Media.isTypeSupported(mime);
      this.onLog('hd-mp4-ready', { mime, reportedMime: info.mime, supported,
        tracks: info.tracks.map(track => ({ codec: track.codec, width: track.video?.width, height: track.video?.height })) });
      if (!supported) {
        this.software = new Software({ parser: this.parser, info, video, onFrame, onError, onLog });
        this.parser = null;
        this.queue = []; this.bytes = 0;
        return;
      }
      this.source = new Media();
      this.source.addEventListener('sourceopen', () => {
        if (this.closed) return;
        try {
          this.buffer = this.source.addSourceBuffer(mime);
          this.buffer.addEventListener('error', () => this.error('The browser could not decode the HD stream. Select SD to keep watching.'));
          this.buffer.addEventListener('updateend', () => { if (!this.closed) { this.followLive(); this.drain(); } });
          this.drain();
        } catch (error) { this.error('Could not initialize HD playback: ' + error.message); }
      }, { once: true });
      video.srcObject = null;
      this.objectUrl = urls.createObjectURL(this.source);
      video.src = this.objectUrl;
      video.play().catch(() => this.onLog('autoplay-paused', { detail: 'Use the video play control.' }));
    };
    this.parser.onError = () => this.error('The camera sent an unsupported HD MP4 stream. Select SD to keep watching.');
    this.channel = peer.createDataChannel('fmp4Stream', { maxRetransmits: 5 });
    this.channel.binaryType = 'arraybuffer';
    this.messageQueue = Promise.resolve();
    this.channel.onopen = () => { if (!this.closed) this.onLog('hd-channel-open'); };
    this.channel.onmessage = event => {
      this.messageQueue = this.messageQueue.then(() => this.message(event.data)).catch(error => this.error(error.message));
    };
    this.channel.onerror = () => this.error('The camera HD data channel failed.');
    this.channel.onclose = () => { if (!this.closed) this.error('The camera HD data channel closed.'); };
    this.onVideoError = () => { if (!this.closed) this.error('HD video decoding failed. Select SD to keep watching.'); };
    video.addEventListener('error', this.onVideoError);
  }
  send(type, msg) { if (!this.closed && this.channel.readyState === 'open') this.channel.send(JSON.stringify({ type, msg })); }
  async message(data) {
    if (this.closed) return;
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (message.type === 'codec') {
        const mime = `video/mp4; codecs="${message.msg}"`;
        const supported = typeof message.msg === 'string' && this.Media.isTypeSupported(mime);
        this.onLog('hd-codec', { codec: String(message.msg).slice(0, 160), supported });
        // The software decoder also consumes fMP4. Ask the camera for MP4
        // even if native MediaSource rejects the advertised codec.
        this.send('start', 'fmp4');
      } else if (message.type === 'recv') {
        this.send('complete', '');
        if (message.msg) this.error('The camera selected its software-decoder format. This HD player needs MP4 output; select SD for now.');
      }
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) data = await data.arrayBuffer();
    if (this.closed) return;
    if (!(data instanceof ArrayBuffer)) throw new Error('Unknown HD data format.');
    const chunk = this.fragments.push(data);
    if (!chunk) return;
    if (this.software) {
      this.software.push(chunk, this.fileOffset); this.fileOffset += chunk.byteLength;
      return;
    }
    this.queue.push(chunk); this.bytes += chunk.byteLength;
    if (this.bytes > 32 * 1024 * 1024) return this.error('The HD decoder fell behind. Stop and retry, or select SD.');
    if (!this.parsed) {
      const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      buffer.fileStart = this.fileOffset; this.fileOffset += buffer.byteLength;
      this.parser.appendBuffer(buffer);
      if (this.parsed) { this.parser?.stop(); this.parser = null; }
    }
    this.drain();
  }
  followLive() {
    const buffered = this.video.buffered;
    if (!buffered?.length) return;
    const end = buffered.end(buffered.length - 1), start = buffered.start(0);
    if (this.video.currentTime < start || end - this.video.currentTime > 3) this.video.currentTime = Math.max(start, end - 0.5);
  }
  drain() {
    if (this.closed || !this.buffer || this.buffer.updating || this.source.readyState !== 'open') return;
    try {
      const cut = this.video.currentTime - 20;
      if (cut > 0 && this.buffer.buffered.length && this.buffer.buffered.start(0) < cut - 5) {
        this.buffer.remove(0, cut); return;
      }
      if (!this.queue.length) return;
      const chunk = this.queue.shift(); this.bytes -= chunk.byteLength;
      this.buffer.appendBuffer(chunk);
    } catch (error) { this.error('Could not buffer HD video: ' + error.message); }
  }
  error(message) { if (!this.closed) this.onError(message); }
  close() {
    this.closed = true;
    this.channel.onopen = this.channel.onmessage = this.channel.onerror = this.channel.onclose = null;
    this.channel.close();
    this.software?.close();
    this.parser?.stop(); this.parser = null;
    this.video.removeEventListener('error', this.onVideoError);
    if (this.objectUrl) {
      this.video.removeAttribute('src'); this.video.load(); this.urls.revokeObjectURL(this.objectUrl);
    }
    this.queue = []; this.bytes = 0; this.fragments.reset();
  }
}
