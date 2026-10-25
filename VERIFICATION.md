# Separation verification — 25 October 2026

## Result

Both applications were copied individually to temporary directories outside the
Camera workspace. No Hikvision or sibling source was present in those copies.

- v1: 22 automated tests passed; zero failures or skips.
- v2: 22 automated tests passed; zero failures or skips.
- Both `server.mjs` entry points started and served health, UI, modules and vendor
  assets successfully from the isolated copies.
- v1's compatibility `node server.js` launcher also passed the startup check.
- Version-specific cookie names and correct WASM MIME type were checked.
- Module dependency paths and the frontend DOM contract were checked.
- Source/configuration paths were confirmed inaccessible through static serving.

The repeatable command from this directory is:

```sh
npm run verify:standalone
```

## Chrome checks

Headless Chrome loaded each real app against an injected, simulated provider.
Both passed QR rendering, QR polling/login, literal camera-name rendering,
offline-camera feedback, empty-account rendering and expired-session recovery.
Neither produced a JavaScript page error. Non-local browser requests were blocked.

Git ignore rules were checked in a disposable repository: private history,
environment files and installed dependencies were ignored; source, package locks,
vendored WASM and license notices remained eligible for inclusion.

## Real-camera boundary

No live CPPlus account or camera was used during separation. A fresh QR scan and
actual SD/HD playback remain manual acceptance checks. Historical v2 SD playback
evidence is documented in its README; it is not a new live verification of v1.

No repository was initialized in this workspace, no remote push was made, no
Hikvision source was edited, and the VPS was not contacted. Temporary test servers
and copies were closed/removed. Source folders remain ready for your Git backup.
