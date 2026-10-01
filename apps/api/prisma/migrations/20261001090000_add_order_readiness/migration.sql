-- AlterTable
ALTER TABLE "DCAStrategy" ADD COLUMN     "readyAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LimitOrder" ADD COLUMN     "readyAt" TIMESTAMP(3),
ADD COLUMN     "readyPrice" TEXT;

