
-- DEFAULT, so existing rows keep working unchanged.
ALTER TABLE "DeliveryScheduleConfig" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
