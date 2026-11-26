import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { initDatabase, closeDatabase } from "../database/db.js";
import productRoutes from "./routes/productRoutes.js";
import customerRoutes from "./routes/customerRoutes.js";
import saleRoutes from "./routes/saleRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";
import importHistoryRoutes from "./routes/importHistoryRoutes.js";
import purchaseOrderRoutes from "./routes/purchaseOrderRoutes.js";
import supplierRoutes from "./routes/supplierRoutes.js";
import medAgentRoutes from "./routes/medAgentRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

const __dirname = path.resolve();
dotenv.config();
dotenv.config({ path: path.join(__dirname, "backend", ".env") });

// 1. Initialize local SQLite database runtime
// Ensure the server DOES NOT accept requests if SQLite fails to initialize
try {
  initDatabase();
  console.log("[Desktop] SQLite database initialized successfully (Zero MongoDB dependency).");
} catch (dbErr) {
  console.error("[Desktop] FATAL: Failed to initialize SQLite database:", dbErr);
  process.exit(1);
}

// 2. Initialize Express application
const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// 3. API Routes
app.use("/api/admin", adminRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/sales", saleRoutes);
app.use("/api/users", authRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/import-history", importHistoryRoutes);
app.use("/api/purchase-orders", purchaseOrderRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/medagent", medAgentRoutes);

// 4. Global Error Handler
app.use((err, req, res, next) => {
  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  const msg = err.message || "An unexpected error occurred";
  res.status(statusCode).json({
    message: msg,
    isFrozen: msg.toLowerCase().includes("frozen"),
    isSessionRevoked:
      msg.toLowerCase().includes("session") &&
      (msg.toLowerCase().includes("revoked") ||
        msg.toLowerCase().includes("reset") ||
        msg.toLowerCase().includes("expired") ||
        msg.toLowerCase().includes("another device")),
  });
});

// 5. Health Check Endpoint
app.get("/api/health", (req, res) => {
  res.json({
    app: "mediblix",
    service: "mediblix-backend",
    status: "healthy",
    database: "sqlite",
    mode: "local-first",
    pid: process.pid,
    timestamp: new Date().toISOString()
  });
});

// 6. Frontend Static Assets (Production)
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "/frontend/dist")));

  app.get(/.*/, (req, res) =>
    res.sendFile(path.resolve(__dirname, "frontend", "dist", "index.html"))
  );
} else {
  app.get("/", (req, res) => {
    res.send("Mediblix Desktop API running with SQLite....");
  });
}

// 7. Server Listener & Graceful Shutdown
const PORT = process.env.PORT || 5001;
let server = null;

if (process.env.NODE_ENV !== "test") {
  server = app.listen(PORT, () => {
    console.log(`[Desktop] Server running on port ${PORT} (SQLite local-first)`);
  });
}

const gracefulShutdown = (signal) => {
  console.log(`[Desktop] Received ${signal}. Shutting down gracefully...`);
  if (server) {
    server.close(() => {
      console.log("[Desktop] HTTP server closed.");
      try {
        closeDatabase();
        console.log("[Desktop] SQLite database closed gracefully.");
      } catch (err) {
        console.error("[Desktop] Error closing database:", err);
      }
      process.exit(0);
    });
  } else {
    try {
      closeDatabase();
    } catch (err) {}
    process.exit(0);
  }
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

export default app;
