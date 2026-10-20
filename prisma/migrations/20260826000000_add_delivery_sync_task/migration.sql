-- Durable work record for the orders/create delivery sync (ADR-22, Phase A of
-- docs/proposals/orders-async-jobs.md). Work bookkeeping only -- the Shopify
-- order stays the delivery-state ledger. One row per (shop, order): which
-- idempotent sync step is already done, the frozen checkout-time validation
-- clock, the worker lease (lockedAt), and when the sweep may retry.
CREATE TABLE "DeliverySyncTask" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT,
    "deliveryDate" TEXT,
    "timeSlot" TEXT,
    "checkoutTime" TIMESTAMP(3) NOT NULL,
    "needsCodFee" BOOLEAN NOT NULL DEFAULT false,
    "metafieldsDone" BOOLEAN NOT NULL DEFAULT false,
    "tagsDone" BOOLEAN NOT NULL DEFAULT false,
    "codFeeDone" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lockedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "DeliverySyncTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliverySyncTask_shop_shopifyOrderId_key" ON "DeliverySyncTask"("shop", "shopifyOrderId");

CREATE INDEX "DeliverySyncTask_status_nextAttemptAt_idx" ON "DeliverySyncTask"("status", "nextAttemptAt");

CREATE INDEX "DeliverySyncTask_shop_status_idx" ON "DeliverySyncTask"("shop", "status");
