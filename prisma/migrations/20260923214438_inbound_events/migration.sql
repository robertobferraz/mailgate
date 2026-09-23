-- CreateTable
CREATE TABLE "inbound_events" (
    "provider_event_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "outcome" TEXT,
    "approval_request_id" UUID,
    "classification" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "inbound_events_pkey" PRIMARY KEY ("provider_event_id")
);

ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_outcome_check" CHECK (outcome IS NULL OR outcome IN
  ('PROCESSED','CLARIFICATION_SENT','IGNORED_UNCLEAR','IGNORED_UNKNOWN_THREAD','IGNORED_SENDER','IGNORED_ALREADY_DECIDED'));
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_approval_fk"
  FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL;
CREATE INDEX "inbound_events_pending_idx" ON "inbound_events" ("received_at") WHERE outcome IS NULL;
