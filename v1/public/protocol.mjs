// Verified against EzyKam playback-52edcdb5386b73c14c71.js, V3 player.
export const WIRE_STREAM = Object.freeze({ 2: 0, 4: 1, 8: 2 });
export function sessionId() { return crypto.randomUUID().replaceAll('-', ''); }
export function streamConfig(config, { quality = 'sd' } = {}) {
  const skill = typeof config.skill === 'string' ? JSON.parse(config.skill) : config.skill;
  const videos = skill?.videos || [];
  const stream = quality === 'hd'
    ? videos.find(v => v.streamType === 2 && [2, 4].includes(v.codecType))
    : videos.find(v => v.streamType === 4 && v.codecType === 2)
      || videos.find(v => v.codecType === 2 && WIRE_STREAM[v.streamType] !== undefined);
  if (!stream) throw new Error(quality === 'hd' ? 'This camera does not advertise a supported main stream. Select SD.' : 'This camera has no advertised H264 stream. Its H265 stream requires a different decoder.');
  const token = (config.p2pConfig?.ices || []).filter(ice => {
    const urls = Array.isArray(ice.urls) ? ice.urls : [ice.urls];
    return urls.some(url => /^(stun|turn|turns):/.test(url || ''));
  });
  if (!token.length || !config.motoId || !config.auth) throw new Error('Camera configuration is missing signaling or ICE credentials.');
  const iceServers = token.map(({ urls, username, credential }) => ({ urls, ...(username ? { username, credential } : {}) }));
  const target = config.sub && config.gatewayId && config.nodeId ? config.gatewayId : config.id;
  return { stream, hevc: stream.codecType === 4, token, iceServers, target, subDevice: target !== config.id ? config.nodeId : '' };
}
export function envelope(session, type, msg, now = Date.now()) {
  return { protocol: 302, pv: session.pv, t: now, data: {
    header: { from: session.msid, to: session.target, sub_dev_id: session.subDevice || '',
      sessionid: session.id, moto_id: session.motoId, seq: 0, rtx: 0, type }, msg
  } };
}
export function offerMessage(sdp, config, selected) {
  return { sdp, auth: config.auth, mode: 'webrtc', datachannel_enable: selected.hevc,
    token: selected.token, stream_type: WIRE_STREAM[selected.stream.streamType], replay: { is_replay: 0 } };
}
export function remoteCandidate(candidate) {
  return { sdpMid: '0', sdpMLineIndex: 0, candidate: String(candidate).replace(/^a=/, '').trim() };
}
export function redact(value) {
  return JSON.parse(JSON.stringify(value, (key, val) =>
    /^(password|passwd|credential|auth|localKey|secKey|token|sdp|candidate|msid|from|to|sessionid|moto_id)$/i.test(key) ? '[redacted]' : val));
}
