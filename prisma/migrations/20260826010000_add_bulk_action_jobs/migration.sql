-- Bulk-action jobs (ADR-22 Phase B, review finding S4): one job + per-order
-- items per large /app/orders bulk op. Work bookkeeping only -- the order
-- writes land on Shopify via the same shared executor the inline path uses.
CREATE TABLE "BulkActionJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "paramsJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "lockedAt" TIMESTAMP(3),
    "totalCount" INTEGER NOT NULL,
    "okCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkActionJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BulkActionJobItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "message" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkActionJobItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BulkActionJob_shop_status_createdAt_idx" ON "BulkActionJob"("shop", "status", "createdAt");

CREATE INDEX "BulkActionJob_status_updatedAt_idx" ON "BulkActionJob"("status", "updatedAt");

CREATE UNIQUE INDEX "BulkActionJobItem_jobId_shopifyOrderId_key" ON "BulkActionJobItem"("jobId", "shopifyOrderId");

CREATE INDEX "BulkActionJobItem_jobId_status_idx" ON "BulkActionJobItem"("jobId", "status");

ALTER TABLE "BulkActionJobItem" ADD CONSTRAINT "BulkActionJobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BulkActionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
