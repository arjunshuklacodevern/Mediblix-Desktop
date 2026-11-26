import repositories from "../../database/repositories/index.js";
import { getTenantContext } from "../utils/tenantHelper.js";
import aiRouter from "../services/ai/aiRouter.js";

const { getDatabase, productRepository } = repositories;

// ─────────────────────────────────────────────────
// POST /api/medagent/chat — Main hybrid chat endpoint
// ─────────────────────────────────────────────────
const handleChat = async (req, res) => {
  const { message, conversationHistory } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ message: "Message is required" });
  }

  try {
    const orgId = await getTenantContext(req);
    const result = await aiRouter.routeChat(message, conversationHistory, orgId);
    return res.json(result);
  } catch (error) {
    console.error("MedAgent Error:", error.message);
    res.status(500).json({
      type: "error",
      mode: "offline",
      message:
        "An unexpected error occurred while processing your request. You can check your local Inventory directly.",
    });
  }
};

// ─────────────────────────────────────────────────
// POST /api/medagent/alternatives — Direct alternatives lookup
// ─────────────────────────────────────────────────
const getAlternatives = async (req, res) => {
  const { medicineName, category } = req.body;

  if (!medicineName) {
    return res.status(400).json({ message: "Medicine name is required" });
  }

  try {
    const orgId = await getTenantContext(req);
    const searchCategory = category || "General";
    const alts = aiRouter.findSqliteAlternatives(searchCategory, medicineName, orgId, 5);

    return res.json({
      originalMedicine: medicineName,
      alternatives: alts.map((a) => ({
        productId: a._id,
        name: a.name,
        category: a.category,
        currentStock: a.quantity,
        stockStatus: a.status,
        price: a.price,
        expiryDate: a.expiryDate,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────
// GET /api/medagent/categories — List inventory categories
// ─────────────────────────────────────────────────
const getCategories = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const orgInternalId = repositories.organizationRepository.findById(orgId)?.id;
    const db = getDatabase();

    const rows = db
      .prepare(
        "SELECT DISTINCT category FROM products WHERE organization_id = ? AND category IS NOT NULL ORDER BY category ASC"
      )
      .all(orgInternalId);

    res.json({ categories: rows.map((r) => r.category) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────
// GET /api/medagent/status — Get active Hybrid AI status
// ─────────────────────────────────────────────────
const getAiStatus = async (req, res) => {
  try {
    const status = aiRouter.getHybridStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────
// GET /api/medagent/insights — Real-time local inventory insights
// ─────────────────────────────────────────────────
const getInsights = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const insights = aiRouter.getOfflineInventoryInsights(orgId);
    res.json(insights);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export { handleChat, getAlternatives, getCategories, getAiStatus, getInsights };
