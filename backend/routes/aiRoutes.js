import express from "express";
import { parseInvoice, parseBill, getAIStatus, installModel } from "../controllers/aiController.js";
import { protect } from "../utils/authMiddleware.js";

const router = express.Router();

// Enforce authentication on AI parsing operations
router.use(protect);

router.get("/status", getAIStatus);
router.post("/install-model", installModel);
router.post("/parse-invoice", parseInvoice);
router.post("/parse-bill", parseBill);

export default router;
