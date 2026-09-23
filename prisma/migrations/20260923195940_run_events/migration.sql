-- CreateTable
CREATE TABLE "run_events" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_events_run_id_at_idx" ON "run_events"("run_id", "at");

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
