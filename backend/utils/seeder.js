/**
 * Mediblix Desktop — SQLite Seeder
 *
 * Seeds baseline records (Master organization, Super Admin user, default suppliers, sample PO)
 * into the local SQLite database.
 */

import { initDatabase, closeDatabase } from "../../database/db.js";

const runSeeder = () => {
  try {
    console.log("[Seeder] Initializing and seeding local SQLite database...");
    initDatabase();
    console.log("[Seeder] SQLite seeding completed successfully.");
    closeDatabase();
  } catch (error) {
    console.error("[Seeder] Seeding error:", error);
    process.exit(1);
  }
};

runSeeder();
