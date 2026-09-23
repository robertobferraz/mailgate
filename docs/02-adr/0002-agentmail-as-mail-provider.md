# 0002 — AgentMail as the mail provider
date:     2026-09-23
status:   active
context:  the flow needs outbound send plus inbound replies via webhook, with reply correlation, send idempotency, signed webhooks and a stable event id.
decision: use AgentMail behind a MailProvider port (send, reply, parseInbound), with Resend as fallback if the F3 spike fails.
consequences: thread_id correlation plus Idempotency-Key (24h) on send, Svix signatures, svix-id for dedupe, free tier with @agentmail.to inbox. SDK is 0.x and releases often: pin the exact version. Unconfirmed items (Idempotency-Key absent from send reference, extracted_text in webhook, retry policy) are checked in the F3 spike.
source:   workstream mailgate · /sdd start (brainstorm + research) · RESEARCH.md Q1, Q2
