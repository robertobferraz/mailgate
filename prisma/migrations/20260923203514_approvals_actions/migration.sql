-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "tool_use_id" TEXT NOT NULL,
    "approver_email" TEXT NOT NULL,
    "subject_token" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "decision" TEXT,
    "decision_note" TEXT,
    "decision_raw_text" TEXT,
    "provider_message_id" TEXT,
    "provider_thread_id" TEXT,
    "clarification_sent" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "tool_use_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_subject_token_key" ON "approval_requests"("subject_token");

-- CreateIndex
CREATE INDEX "approval_requests_provider_thread_id_idx" ON "approval_requests"("provider_thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_run_id_tool_use_id_key" ON "approval_requests"("run_id", "tool_use_id");

-- CreateIndex
CREATE UNIQUE INDEX "actions_run_id_tool_use_id_key" ON "actions"("run_id", "tool_use_id");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_status_check"
  CHECK (status IN ('CREATED','SENT','DECIDED','EXPIRED'));
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decision_check"
  CHECK (decision IS NULL OR decision IN ('APPROVED','REJECTED'));
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_recommendation_check"
  CHECK (recommendation IN ('APPROVE','REJECT'));
ALTER TABLE "actions" ADD CONSTRAINT "actions_type_check"
  CHECK (type IN ('REIMBURSEMENT_APPROVED','REIMBURSEMENT_REJECTED'));
CREATE INDEX "approval_requests_open_idx" ON "approval_requests" ("expires_at") WHERE status IN ('CREATED','SENT');
