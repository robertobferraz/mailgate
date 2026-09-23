-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check"
  CHECK (status IN ('PENDING','RUNNING','WAITING_APPROVAL','COMPLETED','FAILED','EXPIRED'));
CREATE INDEX "runs_claimable_idx" ON "runs" ("created_at") WHERE status IN ('PENDING','RUNNING');
