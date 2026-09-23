# 0004 — ESM-only dependency (svix) fails to load under Jest on Node 22
date:  2026-09-23
what broke: unit tests importing svix failed to load the package; svix ships only dist/index.mjs.
why:   Jest 30 runs tests in a CommonJS VM and only allows native require(esm) on Node 24.9+. The project is pinned to Node 22 (AgentMail SDK issue #12), and node_modules is not transformed by default.
how to avoid: when adding an ESM-only package, add it to the carve-out in both jest.config.js and jest.int.config.js — `transformIgnorePatterns: ['/node_modules/(?!svix/)']` plus the `^.+\\.mjs$` ts-jest transform with `{ allowJs: true, module: 'commonjs' }` — extending the regex group (e.g. `(?!svix/|other/)`). Do not upgrade Node to work around it. Production is unaffected.
cost:  part of one implementer loop in w5 T13.
