import express from "express";
import {
  handleChat,
  getAlternatives,
  getCategories,
  getAiStatus,
  getInsights,
} from "../controllers/medAgentController.js";
import { protect } from "../utils/authMiddleware.js";

const router = express.Router();

// Enforce authentication on all AI assistant operations
router.use(protect);

router.get("/status", getAiStatus);
router.get("/insights", getInsights);
router.post("/chat", handleChat);
router.post("/alternatives", getAlternatives);
router.get("/categories", getCategories);

export default router;
