# 0003 — Prisma 7 client fails to load under Jest's CJS VM with `module: nodenext`
date:  2026-09-23
what broke: integration tests failed with "A dynamic import callback was invoked without --experimental-vm-modules" from src/generated/prisma/internal/class.ts.
why:   the generated client (moduleFormat cjs) loads its WASM query compiler through a native `import()`; ts-jest compiling with the root tsconfig (`module: nodenext`) keeps it as a real dynamic import, which Jest's CommonJS VM cannot execute.
how to avoid: jest.int.config.js passes ts-jest a tsconfig override `{ module: 'commonjs', moduleResolution: 'node10', resolvePackageJsonExports: false }` so the import is downleveled to require; keep it when adding new Jest configs that touch the Prisma client. Production (`node dist/main.js`) is unaffected.
cost:  one debugging loop in w2 T3.
