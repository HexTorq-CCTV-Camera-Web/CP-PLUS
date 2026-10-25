# CPPlus / EzyKam v1 (repaired)

The original simple camera interface, packaged as an independent application.
Node.js 22+ is required on Windows, Linux or macOS. No installation/build step,
Hikvision SDK, database or parent folder is required.

```powershell
cd K:\2026-SHOP\Playground\Camera\CPPLUS\v1
npm start
```

Open http://localhost:8000. You can also use `node server.js` for the original
entry-point name. To change port: `$env:PORT = '8010'; npm start`.
On Linux/macOS: `PORT=8010 npm start`. `.env.example` documents options; `.env`
is not loaded automatically. The default bind address is 127.0.0.1.

1. Scan the QR with EzyKam+ and confirm access.
2. Choose an online camera. This simple interface selects SD/H264.
3. Use the video controls to unmute. Stop other viewers before retrying;
   camera switching includes a ten-second release wait.
4. Sign out to clear this browser's provider connection.

## Repairs made during separation

The original script had a missing UUID function, wrong wire-stream value,
mismatched session/trace IDs and incomplete ICE/release handling. Its fragile
inline signaling was replaced with a local copy of v2's corrected player and
proxy. The simple interface remains distinct. QR polling, empty accounts,
expired sessions, safe camera-name rendering and real sign-out use the repaired
application flow. This version has no import, filesystem reference or runtime
link to v2. Its bundled decoder modules remain transitive player dependencies;
use v2's interface for HD selection.

`server.mjs` serves only `public/`; source, tests and configuration are private.
Session cookies use the v1 name, separate from v2. Upstream sessions live in
memory and are lost on server restart. This is a local viewer, not a multi-user
production service.

## Files and checks

- `server.mjs`: HTTP proxy and local sessions.
- `server.js`: backward-compatible command-line launcher.
- `public/`: simple UI, player, signaling, decoder and vendored assets/notices.
- `test/`: isolated proxy, signaling, decoder and packaging regression tests.

Run `npm test`. All tests use simulated upstreams. Run a real QR login and live
SD camera check before relying on the restored app; no fresh real-device success
is implied by the automated checks. From the parent directory,
`npm run verify:standalone` tests each app in an unrelated temporary directory.
Keep `public/vendor/` and its license/source notices when copying to Git.
