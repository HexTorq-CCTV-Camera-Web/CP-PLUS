import { sessionId, streamConfig, envelope, offerMessage, remoteCandidate, redact } from './protocol.mjs';
import { HevcPlayer } from './hevc.mjs';

export class CameraPlayer {
  constructor({ api, video, onState, onLog, Peer = globalThis.RTCPeerConnection,
    mqtt = globalThis.mqtt, makeId = sessionId, offerTimeout = 30000, frameTimeout = 25000, HdPlayer = HevcPlayer }) {
    Object.assign(this, { api, video, onState, onLog, Peer, mqtt, makeId, offerTimeout, frameTimeout, HdPlayer });
    this.active = null;
    this.lastStopped = 0;
    this.trace = [];
  }
  event(type, details = {}) {
    const entry = { time: new Date().toISOString(), type, ...redact(details) };
    this.trace.push(entry);
    if (this.trace.length > 300) this.trace.shift();
    this.onLog(entry);
  }
  state(name, detail = '') { this.onState(name, detail); this.event(name, { detail }); }
  current(s) { return this.active === s && !s.stopped; }
  async start(camera, { quality = 'sd' } = {}) {
    this.stop();
    const s = { id: this.makeId(), devId: camera.devId, stopped: false, timers: [],
      localCandidates: [], remoteCandidates: [], answered: false, queue: Promise.resolve() };
    this.active = s;
    this.trace = [];
    const guard = () => { if (!this.current(s)) throw new DOMException('Playback cancelled', 'AbortError'); };
    const timer = (fn, ms) => { const id = setTimeout(() => { if (this.current(s)) fn(); }, ms); s.timers.push(id); return id; };
    try {
      if (!this.mqtt) throw new Error('The MQTT library did not load. Reload the page.');
      if (!this.Peer) throw new Error('WebRTC is unavailable. Open this page on localhost or HTTPS.');
      const remaining = 10000 - (Date.now() - this.lastStopped);
      if (remaining > 0) {
        this.state('releasing', 'Waiting for the previous camera session to release…');
        await new Promise(resolve => { s.releaseWait = resolve; timer(resolve, remaining); });
        guard();
      }
      this.state('config', 'Fetching fresh camera credentials…');
      const config = await this.api('/api/rtc', { devId: camera.devId, clientTraceId: s.id });
      guard();
      const selected = streamConfig({ ...config.result, id: camera.devId }, { quality });
      s.codec = selected.hevc ? 'H265' : 'H264';
      s.quality = quality;
      Object.assign(s, { motoId: config.result.motoId, target: selected.target,
        subDevice: selected.subDevice, pv: config.result.protocolVersion || '2.2' });
      this.event('stream-selected', { codec: s.codec, quality, width: selected.stream.width,
        height: selected.stream.height, internalStream: selected.stream.streamType,
        wireStream: offerMessage('', config.result, selected).stream_type });
      const credentials = await this.api('/api/msid');
      guard();
      if (!credentials.result?.msid || !credentials.result?.password) throw new Error('MQTT credentials are missing. Sign in again.');
      s.msid = credentials.result.msid;
      s.peer = new this.Peer({ iceServers: selected.iceServers, bundlePolicy: 'max-bundle' });
      s.peer.addTransceiver('audio', { direction: selected.hevc ? 'sendonly' : 'sendrecv' });
      if (!selected.hevc) {
        s.peer.addTransceiver('video', { direction: 'recvonly' });
        s.media = new MediaStream();
        this.video.srcObject = s.media;
      } else {
        s.hd = new this.HdPlayer({ peer: s.peer, video: this.video,
          onError: detail => this.fail(s, detail), onLog: (type, details) => this.event(type, details),
          onFrame: ({ width, height, software }) => {
            if (!this.current(s)) return;
            s.rendered = true; clearTimeout(s.framesTimer);
            s.playingDetail = `Live · H265 · ${width}×${height}${software ? ' · software · video only' : ''}`;
            this.state('playing', s.playingDetail);
          } });
      }
      s.peer.ontrack = event => {
        if (!this.current(s)) return;
        if (selected.hevc) return;
        if (!s.media.getTracks().includes(event.track)) s.media.addTrack(event.track);
        this.event('track', { kind: event.track.kind });
        this.video.play().catch(() => this.event('autoplay-paused', { detail: 'Use the video play control.' }));
      };
      this.video.onplaying = () => {
        if (!this.current(s) || !this.video.videoWidth) return;
        s.rendered = true;
        clearTimeout(s.framesTimer);
        s.playingDetail = `Live · ${s.codec} · ${this.video.videoWidth}×${this.video.videoHeight}`;
        this.state('playing', s.playingDetail);
      };
      s.peer.onicecandidate = event => {
        if (!this.current(s)) return;
        const candidate = event.candidate ? 'a=' + event.candidate.candidate : '';
        if (candidate.includes('.local')) return;
        const msg = { candidate, mode: 'webrtc' };
        if (!s.answered) s.localCandidates.push(msg);
        if (s.subscribed) this.publish(s, 'candidate', msg);
      };
      s.peer.oniceconnectionstatechange = () => {
        if (this.current(s)) this.event('ice-state', { state: s.peer.iceConnectionState });
      };
      s.peer.onconnectionstatechange = () => {
        if (!this.current(s)) return;
        const connection = s.peer.connectionState;
        this.event('peer-state', { state: connection });
        if (connection === 'failed') this.fail(s, 'The WebRTC connection failed. Check the network and try again.');
        if (connection === 'disconnected') {
          this.state('interrupted', 'Connection interrupted…');
          timer(() => { if (s.peer.connectionState === 'disconnected') this.fail(s, 'The camera connection was lost.'); }, 10000);
        }
        if (connection === 'connected' && s.rendered) this.state('playing', s.playingDetail);
      };
      const offer = await s.peer.createOffer({ voiceActivityDetection: true, iceRestart: false });
      guard();
      await s.peer.setLocalDescription(offer);
      guard();
      s.offer = offerMessage(offer.sdp, config.result, selected);
      this.state('mqtt', 'Connecting to camera signaling…');
      s.mqtt = this.mqtt.connect('wss://m1-cube.cppluscloud.com/mqtt', {
        username: 'web_' + s.msid, password: credentials.result.password,
        clientId: 'web_' + this.makeId().slice(0, 16), clean: true, reconnectPeriod: 0, connectTimeout: 15000
      });
      s.timers.push(setTimeout(() => this.fail(s, 'Signaling timed out before the camera subscription was ready.'), 20000));
      s.mqtt.on('error', () => this.fail(s, 'Camera signaling failed. Sign in again or retry.'));
      s.mqtt.on('close', () => { if (this.current(s)) this.fail(s, 'The signaling connection closed.'); });
      s.mqtt.on('message', (_topic, buffer) => {
        s.queue = s.queue.then(() => this.message(s, buffer, timer)).catch(error => this.fail(s, error.message));
      });
      s.mqtt.on('connect', () => {
        if (!this.current(s)) return;
        s.mqtt.subscribe('/av/u/' + s.msid, { qos: 1 }, (error, granted) => {
          if (!this.current(s)) return;
          if (error || granted?.some(item => item.qos === 128)) return this.fail(s, 'The signaling subscription was rejected.');
          // Replace the initial connection watchdog with bounded offer retries.
          for (const id of s.timers) clearTimeout(id);
          s.timers = [];
          s.subscribed = true;
          this.state('offer', 'Waiting for the camera to answer…');
          const send = () => {
            if (!this.current(s) || s.answered) return;
            this.publish(s, 'offer', s.offer);
            for (const candidate of s.localCandidates) this.publish(s, 'candidate', candidate);
            timer(send, 3000);
          };
          send();
          s.answerTimer = timer(() => this.fail(s, 'The camera did not answer within 30 seconds. Stop other viewers, wait 10 seconds, then retry.'), this.offerTimeout);
        });
      });
      return s;
    } catch (error) {
      if (error.name !== 'AbortError') this.fail(s, error.message);
    }
  }
  publish(s, type, msg) {
    if (!this.current(s) || !s.mqtt?.connected) return;
    const packet = envelope(s, type, msg);
    s.mqtt.publish('/av/moto/' + s.motoId + '/u/' + s.target, JSON.stringify(packet), { qos: 1 }, error => {
      if (error) this.fail(s, 'Could not publish the camera signaling message.');
    });
    this.event('outgoing-' + type, { bytes: JSON.stringify(packet).length,
      ...(type === 'offer' ? { wireStream: msg.stream_type } : {}) });
  }
  async message(s, buffer, timer) {
    if (!this.current(s)) return;
    let packet;
    try { packet = JSON.parse(buffer.toString()); } catch { this.event('ignored-message', { reason: 'Invalid JSON' }); return; }
    const header = packet.data?.header;
    const msg = packet.data?.msg;
    if (packet.protocol !== 302 || !header || !msg) return;
    if (header.sessionid !== s.id || header.from === s.msid) { this.event('ignored-message', { reason: 'Another session or our own echo' }); return; }
    this.event('incoming-' + header.type);
    if (header.type === 'disconnect') {
      this.fail(s, msg.sdk_code === 12 || msg.info === 'refused' ? 'The camera is busy with another viewer.' : 'The camera ended the session.');
    } else if (header.type === 'answer' && msg.sdp && !s.answered) {
      await s.peer.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      if (!this.current(s)) return;
      s.answered = true;
      clearTimeout(s.answerTimer);
      this.state('ice', 'Camera answered. Connecting video…');
      s.localCandidates.length = 0;
      for (const candidate of s.remoteCandidates.splice(0)) await s.peer.addIceCandidate(candidate);
      s.framesTimer = timer(() => { if (!s.rendered) this.fail(s, 'The camera answered, but no video rendered. Check ICE connectivity and camera stream settings.'); }, this.frameTimeout);
    } else if (header.type === 'candidate' && msg.candidate) {
      const candidate = remoteCandidate(msg.candidate);
      if (s.answered) await s.peer.addIceCandidate(candidate); else s.remoteCandidates.push(candidate);
    }
  }
  fail(s, detail) {
    if (!this.current(s)) return;
    this.event('failure', { detail });
    this.stop();
    this.state('error', detail);
  }
  stop() {
    const s = this.active;
    if (!s) return;
    if (s.peer || s.mqtt) this.lastStopped = Date.now();
    s.stopped = true;
    this.active = null;
    for (const id of s.timers) clearTimeout(id);
    s.releaseWait?.();
    this.video.onplaying = null;
    s.hd?.close();
    if (s.peer) {
      s.peer.ontrack = s.peer.onicecandidate = s.peer.onconnectionstatechange = s.peer.oniceconnectionstatechange = null;
      s.peer.close();
    }
    if (s.mqtt) {
      s.mqtt.removeAllListeners();
      s.mqtt.on('error', () => {});
      if (s.mqtt.connected && s.subscribed) {
        // The official V3 client releases preview with protocol 312.
        const packet = envelope(s, 'disconnect', {});
        packet.protocol = 312;
        packet.data.header.tid = crypto.randomUUID();
        const closeTimer = setTimeout(() => s.mqtt.end(true), 500);
        s.mqtt.publish('/av/moto/' + s.motoId + '/u/' + s.target, JSON.stringify(packet), { qos: 1 }, () => {
          clearTimeout(closeTimer); s.mqtt.end(true);
        });
      } else s.mqtt.end(true);
    }
    this.video.onplaying = null;
    this.video.srcObject = null;
  }
}
