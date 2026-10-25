# Camera v2

Fresh local implementation of QR login → cameras → live preview. The original `../index.html`, `../server.js`, and conversation export are unchanged.

From PowerShell:

```powershell
cd K:\2026-SHOP\Playground\Camera\CPPLUS\v2
npm start
```

Open **http://localhost:8002**. Scan the white-padded QR with EzyKam+, approve in the phone app, then select a camera. Stop the official viewer and other camera viewers first. Stop/retry waits ten seconds to let the previous session release. To use a different port: `$env:PORT = '8010'; npm start`.

The quality selector offers **HD · Main stream** (default) and **SD · Compatible**. The recorded main stream is 2304×1296 H265; SD is 640×360 H264. HD uses the official V3 `fmp4Stream` data-channel handshake. It uses native MediaSource decoding when available and otherwise selects a locally vendored libde265 WebAssembly decoder in a worker, rendering to an OffscreenCanvas. Software HD is **video only**; SD retains native video/audio controls. Switching quality releases the current connection and obtains fresh credentials. The live label shows the actual rendered resolution.

The MP4 decoder check uses only the track codecs: MP4Box's file-brand `profiles` parameter is deliberately excluded. `hd-mp4-ready` diagnostics include both MIME descriptions and support results. A rejected native codec is not treated as a final playback failure when the software decoder is available.

No build step or server dependencies. MQTT.js 5.10.3, MP4Box.js 0.5.4, and OpenIPC/libde265 decoder artifacts (with license/source notices) are vendored under `public/vendor` so decoding and signaling don't depend on a runtime CDN. Node 22+ is required. Run `npm test` for the simulated signaling and proxy tests.

## What the history established

The historical conversation export (excluded from Git and unnecessary at runtime) contains 223 messages and 157 tool calls. Login, shared-camera discovery, fresh RTC configuration, and MQTT connection worked in the previous attempt. The custom viewer never demonstrated a received answer or rendered video. The handoff's claims that the protocol was complete and the single-viewer hypothesis was proved go beyond the recorded evidence.

I checked the original official player source referenced in the history:

https://cpplus-eks-prod-public-data-17791850.s3.ap-south-1.amazonaws.com/static/security-wisdom/_next/static/chunks/pages/playback-52edcdb5386b73c14c71.js?v=1

Concrete corrections in v2:

- **Wire stream values differ from skill values.** The V3 player contains `c={2:0,4:1,8:2}` then `stream_type:c[this.streamType]`. H264 substream skill `4` therefore becomes wire `1`. V1 sent `4`.
- **One ID for config and signaling.** `clientTraceId` is the same 32-character session ID placed in the MQTT header. V1 generated two unrelated IDs.
- **ICE is sent before an answer.** The official candidate handler sends `{candidate,mode:"webrtc"}` immediately, skips `.local` host candidates, and resends cached candidates. V1 withheld all local candidates until an answer.
- **Release preview.** Official V3 close sends protocol `312`, header type `disconnect`, a transaction ID, and an empty message. V1 closed its browser resources without telling the camera.
- **Offer SDP is the SDP from `createOffer`.** V2 retains it rather than reading a possibly changed `localDescription` later.
- V1's final session-expiry edit accidentally deleted `uuid()`; v2 has a dedicated UUID helper.

The offer retains auth, fresh ICE token array, mode, and replay flag. Datachannel is disabled for H264 and enabled for H265. Main stream skill value `2` maps to wire value `0`; substream skill value `4` maps to wire value `1`. The initial `302` offer has no transaction ID. Credentials, ICE servers, moto ID, and camera IDs are fetched, never copied from the history.

## Structure and behavior

- `server.mjs`: thin Node proxy; original five API route shapes retained. Adds local session status, logout, and health endpoints.
- `public/protocol.mjs`: explicit V3 packet construction and stream mapping.
- `public/player.mjs`: cancellable connection lifecycle, serialized answer/candidate handling, bounded retries, explicit stop, and video-render-based live status.
- `public/hevc.mjs`: HD data-channel negotiation, four-byte fragment-header handling, MP4 metadata parsing, ordered MediaSource buffering, live-edge tracking, and buffer/resource cleanup.
- `public/hevc-software.mjs` and `public/hevc-worker.mjs`: MP4 video-track extraction, HEVC parameter-set initialization, Annex B conversion, bounded worker feeding, WASM decoding, and WebGL canvas rendering. Only decoded and painted frames can mark software playback live.
- `public/app.mjs`: sequential QR polling, authentication checks through camera listing, safe DOM rendering, empty/offline states, retry, fullscreen, sign out, and redacted diagnostics.
- `test/`: simulated camera and isolated proxy checks, no real credentials or camera connections.

Each browser has a separate HttpOnly session cookie and upstream cookie jar. Reloading the same browser retains login while this Node process runs; restarting Node clears it. Signing out clears this site's upstream credentials. Static serving is restricted to `public/` so the history export and server code aren't downloadable.

For owned cameras, discovery supports the embedded `devices` / `deviceList` forms already used by v1. The recorded account uses a flat shared-camera list. Additional owned-device endpoint flows have not been captured or verified.

## Verification boundary

The user confirmed real SD playback: the camera answered, audio/video tracks arrived, ICE connected, and video rendered. Real HD signaling and data-channel connection were also confirmed; the first HD attempt failed the native MP4 codec check. The updated software fallback passed a Chrome render test with a real HEVC sample, including MP4 demuxing and camera-style fragment headers while native codec support was forced unavailable. Actual camera HD still needs confirmation after refreshing. The official Chrome login is a different session from this proxy. V2 does not import Chrome cookies.

The current implementation targets the recorded V3 camera (`p2pType=4`). V4 signaling, raw RTP decoding, software-path audio, PTZ, recording, public sharing, and production hosting are outside this version. Both native and software H265 over fragmented MP4 are implemented; a camera that selects a raw RTP response instead of MP4 is rejected with an explanation. Software decoding requires WebAssembly SIMD, a module worker, OffscreenCanvas, and WebGL; throughput depends on the device. The ten-second release wait is a conservative mitigation for the reported camera contention; the history did not prove a universal one-viewer limit.

For a later VPS deployment, put this behind HTTPS and site access control, bind `HOST=0.0.0.0` only behind your intended proxy/firewall, and set `COOKIE_SECURE=1`. This task creates a local version and does not publish your cameras.

## Standalone archive

Copy this entire folder to any directory and run `npm start` with Node 22+.
`npm test` runs local simulated-provider tests. No npm install or build is needed.
On Linux/macOS, use `PORT=8010 npm start` for a different port.
`.env.example` documents shell options; real `.env` files are not automatically
loaded. A restart clears the in-memory login; scan a fresh QR afterward.

The v2 session cookie has its own name so running v1 on another localhost port
does not overwrite its session. This does not bypass camera concurrency limits.
Keep all files in `public/vendor/`, including WASM binaries and license/source
notices, in Git. Private history, QR artifacts and logs are excluded.
From the parent directory, `npm run verify:standalone` checks isolated copies.
