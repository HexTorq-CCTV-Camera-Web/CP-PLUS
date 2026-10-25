# CPPLUS / EzyKam camera viewers

These are independent local viewers for CPPlus cameras linked through EzyKam+.
They do not use Hikvision, PostgreSQL, iVMS, Python or Windows DLLs. Node.js 22+
and a modern browser are required. No npm install or build step is required.

See [VERIFICATION.md](VERIFICATION.md) for the separation test results and live-camera boundary.

| App | Purpose | Default address |
| --- | --- | --- |
| [v1](v1/README.md) | Original simple interface, repaired QR/SD playback | http://localhost:8000 |
| [v2](v2/README.md) | Redesigned viewer, HD/SD, H265 software fallback | http://localhost:8002 |

From this directory, use `npm run start:v1` or `npm run start:v2` in separate
terminals. `npm test` runs both suites. `npm run verify:standalone` copies each
app separately to a temporary directory, runs its tests and checks its actual
startup and HTTP assets outside this workspace.

Each version can be copied into its own repository and started with `npm start`.
Every runtime asset and third-party notice is included inside that version.
The two apps use distinct cookie names. Provider sessions are stored only in
server memory; restart/sign-out requires another QR scan. Stop other camera
viewers before playback, especially when comparing versions.

## Git preparation

Commit this directory's source, package locks, tests, README files and **all**
vendored assets and their license/source notices. `.gitignore` excludes private
history, login QR artifacts, logs, real environment files and installed packages.
If `.private-history/` exists locally, it contains historical material that is
not required to run either app and must stay outside Git. Do not force-add it.

Repository: https://github.com/HexTorq-CCTV-Camera-Web/CP-PLUS

After cloning, use `npm run start:v1` or `npm run start:v2` from the repository
root. Verify your clone before removing any local backup. Never commit an active
provider login or credentials.

## Verification boundary

Automated tests use simulated provider/signaling responses. Isolated-copy tests
prove packaging, startup and asset availability; they do not prove live camera
availability or current provider compatibility. Finish acceptance by scanning a
fresh QR in each app and watching a real online camera. Historical real SD
playback was confirmed in v2. HD software fallback has synthetic/sample evidence;
actual camera HD must be confirmed again. There is no production-hosting claim.
