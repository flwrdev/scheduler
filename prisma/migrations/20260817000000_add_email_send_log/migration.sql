-- CreateTable
CREATE TABLE "EmailSendLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSendLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailSendLog_shop_shopifyOrderId_idx" ON "EmailSendLog"("shop", "shopifyOrderId");
