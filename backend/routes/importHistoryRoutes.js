import express from "express";
import {
  getImportHistory,
  getImportHistoryById,
  createImportRecord,
  deleteImportRecord,
  exportImportHistory,
} from "../controllers/importHistoryController.js";
import { protect } from "../utils/authMiddleware.js";

const router = express.Router();

// Enforce authentication on all import history operations
router.use(protect);

router.route("/").get(getImportHistory).post(createImportRecord);
router.route("/:id").get(getImportHistoryById).delete(deleteImportRecord);
router.route("/:id/export").get(exportImportHistory);

export default router;
