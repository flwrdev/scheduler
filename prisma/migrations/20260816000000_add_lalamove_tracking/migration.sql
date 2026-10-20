-- CreateTable
CREATE TABLE "LalamoveTracking" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyFulfillmentId" TEXT NOT NULL,
    "lalamoveOrderId" TEXT NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "deliveredAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LalamoveTracking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LalamoveTracking_lalamoveOrderId_key" ON "LalamoveTracking"("lalamoveOrderId");

-- CreateIndex
CREATE INDEX "LalamoveTracking_shop_deliveredAt_idx" ON "LalamoveTracking"("shop", "deliveredAt");
