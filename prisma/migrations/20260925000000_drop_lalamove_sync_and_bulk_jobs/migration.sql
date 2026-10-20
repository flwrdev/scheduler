-- DropForeignKey
ALTER TABLE "BulkActionJobItem" DROP CONSTRAINT "BulkActionJobItem_jobId_fkey";

-- DropTable
DROP TABLE "LalamoveTracking";

-- DropTable
DROP TABLE "DeliverySyncTask";

-- DropTable
DROP TABLE "BulkActionJob";

-- DropTable
DROP TABLE "BulkActionJobItem";
