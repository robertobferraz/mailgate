# 0004 — Inbound mail webhook
date:     2026-09-23
route:    POST /webhooks/mail
purpose:  receive AgentMail message.received events, dedupe them and hand them to the inbound processor
approved: approved

## Behavior
- given an invalid or missing Svix signature, then 401 and nothing is stored
- given a valid event of another type, then 200 and nothing is stored
- given a valid message.received, then INSERT inbound_events ON CONFLICT DO NOTHING (key svix-id) and 200
- given the same svix-id again, then 200 and no second row (I3)
- the endpoint never classifies or decides; the worker's inbound processor does

## States
loading: n/a · empty: n/a · error: 401 · success: 200

## Data
headers: svix-id, svix-timestamp, svix-signature; raw body required (Nest rawBody: true)
stored: provider_event_id=svix-id, payload = normalized InboundEvent {eventId, type, threadId, messageId, from, subject, text} + raw
