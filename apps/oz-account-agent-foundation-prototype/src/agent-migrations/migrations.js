import receipts from "./20260808000000_receipts/migration.sql";
import receiptStatus from "./20260808000001_receipt_status/migration.sql";

export default {
  migrations: {
    "20260808000000_receipts": receipts,
    "20260808000001_receipt_status": receiptStatus,
  },
  migrationsTable: "oz_drizzle_migrations",
};
