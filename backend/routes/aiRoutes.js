import express from "express";
import { parseInvoice, parseBill, getAIStatus, updateAIProvider } from "../controllers/aiController.js";
import { protect } from "../utils/authMiddleware.js";

const router = express.Router();

// Enforce authentication on AI operations
router.use(protect);

router.post("/parse-invoice", parseInvoice);
router.post("/parse-bill", parseBill);
router.get("/status", getAIStatus);
router.post("/provider", updateAIProvider);

export default router;
