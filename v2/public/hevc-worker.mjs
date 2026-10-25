import createDe265 from './vendor/hevc-wasm/de265.js';
import { makePainter } from './vendor/hevc-wasm/paint.js';

let module, decoder, paint, closed = false, frames = 0;
function reportError(error) { if (!closed) postMessage({ type: 'error', detail: error.message || String(error) }); }
function push(bytes, endFrame) {
  const ptr = module._de_malloc(bytes.length);
  try { module.HEAPU8.set(bytes, ptr); module._de_push(decoder, ptr, bytes.length); }
  finally { module._de_free(ptr); }
  if (endFrame) module._de_end_frame(decoder);
  for (let guard = 0; guard < 64; guard++) {
    const flags = module._de_step(decoder, 50);
    if (flags & 2) {
      try {
        const width = module._de_width(decoder), height = module._de_height(decoder);
        const stridePtr = module._de_malloc(4);
        try {
          const planes = [0, 1, 2].map(index => {
            const ptr = module._de_plane(decoder, index, stridePtr);
            const stride = module.getValue(stridePtr, 'i32');
            const w = index ? (width + 1) >> 1 : width;
            const h = index ? (height + 1) >> 1 : height;
            return { data: module.HEAPU8.subarray(ptr, ptr + stride * h), stride, w, h };
          });
          paint(planes, width, height);
          frames++;
          if (frames === 1 || frames % 60 === 0) postMessage({ type: 'frame', width, height, frames });
        } finally { module._de_free(stridePtr); }
      } finally { module._de_release(decoder); }
    }
    if (flags & 8) throw new Error('The software H265 decoder rejected the camera stream.');
    if (!(flags & 1)) break;
  }
}
let messages = Promise.resolve();
self.onmessage = event => {
  messages = messages.then(async () => {
    const message = event.data;
    if (closed) return;
    if (message.type === 'init') {
      const response = await fetch(new URL('./vendor/hevc-wasm/de265.wasm', import.meta.url));
      if (!response.ok) throw new Error('Could not load the software H265 decoder.');
      module = await createDe265({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
      decoder = module._de_create(-1);
      if (!decoder) throw new Error('Could not initialize the software H265 decoder.');
      const gl = message.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false });
      if (!gl) throw new Error('HD software rendering requires WebGL.');
      paint = makePainter(gl);
      postMessage({ type: 'ready' });
    } else if (message.type === 'config') {
      push(new Uint8Array(message.data), false);
    } else if (message.type === 'sample') {
      push(new Uint8Array(message.data), true);
      postMessage({ type: 'consumed', bytes: message.data.byteLength });
    } else if (message.type === 'close') {
      closed = true;
      if (decoder) module._de_destroy(decoder);
      decoder = null;
    }
  }).catch(reportError);
};
