# 0012 — DEMO mode: fake LLM and mail, real webhook signature
date:     2026-09-23
status:   active
context:  the README GIFs must be recorded automatically and deterministically, without Claude or a real mailbox; fakes existed only under test/.
decision: DEMO=true swaps LLM, classifier and outgoing mail for implementations in src/demo (promoted from test/fakes), while inbound keeps AgentMail's svix verification; scripts/demo-reply.ts signs replies with the svix secret; DEMO is rejected when NODE_ENV=production. GIFs: VHS for the terminal, Playwright + ffmpeg + gifski for the timeline, orchestrated by scripts/record-demo.sh.
consequences: demo code ships in the image but is inert unless DEMO=true; the recorded flow exercises the real signature path; recording needs vhs, ffmpeg and gifski locally.
source:   workstream f6-hardening · /sdd start (brainstorm + research) · RESEARCH.md Q2
