# 0002 — lockfile written on macOS breaks `npm ci` in the alpine image
date:  2026-09-23
what broke: `docker compose up --build` failed at `RUN npm ci` with "Missing: @emnapi/core / @emnapi/runtime from lock file" after an `npm i` run on the host.
why:   npm on macOS prunes the linux/musl-only optional dependencies from package-lock.json; `npm ci` in `node:22-alpine` then sees package.json and the lock out of sync.
how to avoid: after any dependency change, regenerate the lock inside the target image (`docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install --package-lock-only`) and check `grep -c '@emnapi' package-lock.json` did not drop; a compose build is part of verifying any dependency change.
cost:  hit twice in one window (T4, then again after the @types/node pin in T5); one extra fix round.
