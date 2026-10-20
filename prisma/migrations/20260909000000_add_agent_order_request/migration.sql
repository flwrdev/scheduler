-- Idempotency reservation rows for POST /api/agent/orders/draft.
CREATE TABLE "AgentOrderRequest" (
    "idempotencyKey" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "paymentMode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "draftId" TEXT,
    "orderId" TEXT,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentOrderRequest_pkey" PRIMARY KEY ("idempotencyKey")
);

CREATE INDEX "AgentOrderRequest_shop_status_idx" ON "AgentOrderRequest"("shop", "status");
