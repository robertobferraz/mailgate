# 0003 — Runs API
date:     2026-09-23
route:    POST /runs · GET /runs/:id · GET /health
purpose:  create a reimbursement run and read its status and timeline
approved: approved

## Behavior
- given a valid body, when POST /runs, then 201 {id, status: PENDING} and a CREATED run_event in the same transaction
- given an invalid body, when POST /runs, then 400 with validation errors
- given an existing id, when GET /runs/:id, then 200 with status, input, attempts, lastError, approval, action, timeline
- given an unknown id, then 404; given a non-uuid id, then 400
- given the database is reachable, when GET /health, then 200 {status: ok}; otherwise 503

## States
loading: n/a · empty: approval/action null · error: 400/404/503 · success: 201/200

## Data
POST body: description (1–2000), amountCents (int, 1..100000000), category TRAVEL|MEALS|EQUIPMENT|TRAINING|OTHER, requesterEmail, approverEmail (lowercased)
GET: { id, status, input, attempts, lastError, approval: {status, decision, note, expiresAt} | null, action: {type, payload, createdAt} | null, timeline: [{at, type, data}] }
Canonical contract: docs/api/openapi.yaml
