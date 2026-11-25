/**
 * Mediblix Desktop — Database Connection Layer
 *
 * @deprecated MongoDB / Mongoose has been deprecated and decommissioned.
 * Mediblix Desktop operates strictly on local SQLite via database/db.js.
 * This stub is maintained to prevent broken imports if any legacy script references it.
 */

const connectDB = async () => {
  console.log("[DB] Notice: MongoDB is decommissioned. Mediblix Desktop operates strictly on local SQLite.");
  return Promise.resolve();
};

export default connectDB;
