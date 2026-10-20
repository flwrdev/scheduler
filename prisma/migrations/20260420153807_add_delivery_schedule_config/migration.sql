-- CreateTable
CREATE TABLE "DeliveryScheduleConfig" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "cutoffHour" INTEGER NOT NULL,
    "prepHours" INTEGER NOT NULL,
    "maxDays" INTEGER NOT NULL,
    "slotsJson" TEXT NOT NULL,
    "disabledDatesJson" TEXT NOT NULL,
    "disabledSlotsJson" TEXT NOT NULL,
    "slotCapacityJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryScheduleConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryScheduleConfig_shop_key" ON "DeliveryScheduleConfig"("shop");
