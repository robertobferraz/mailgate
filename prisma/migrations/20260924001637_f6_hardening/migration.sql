ALTER TABLE "approval_requests"
  ADD COLUMN "late_reply_sent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "decided_at" TIMESTAMPTZ(3),
  ADD COLUMN "send_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_send_at" TIMESTAMPTZ(3),
  ADD COLUMN "send_lease_until" TIMESTAMPTZ(3);

ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_outcome_check";
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_outcome_check" CHECK (outcome IS NULL OR outcome IN
  ('PROCESSED','CLARIFICATION_SENT','IGNORED_UNCLEAR','IGNORED_UNKNOWN_THREAD','IGNORED_SENDER','IGNORED_ALREADY_DECIDED','IGNORED_EXPIRED','FAILED'));
