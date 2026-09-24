# 0011 — Prisma CLI audit findings: override mysql2, accept deepmerge-ts
date:     2026-09-23
status:   active
context:  npm audit reports 4 high findings, all under the prisma 7.10.0 CLI (runtime dependency for migrate deploy): mysql2 3.15.3 (GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3) and deepmerge-ts 7.1.5 (GHSA-ggr8-5vv4-36mx). npm's suggested fix downgrades to Prisma 6.
decision: add overrides mysql2 ^3.24.4 (lockfile regenerated in node:22-alpine, lesson 0002) and accept deepmerge-ts as a risk until a stable Prisma 8, since it only merges the trusted prisma.config.ts.
consequences: two advisories cleared with a patch-level bump; one high stays in the audit output by decision; revisit on the Prisma 8 upgrade.
source:   workstream f6-hardening · /sdd start (brainstorm + research) · RESEARCH.md Q4
