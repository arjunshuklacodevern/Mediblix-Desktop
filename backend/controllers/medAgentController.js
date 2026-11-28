import repositories from "../../database/repositories/index.js";
import { getTenantContext } from "../utils/tenantHelper.js";
import aiProvider from "../services/aiProvider.js";
import { isAIError, toAIError } from "../services/aiErrors.js";
import {
  validateAppGuidance,
  validateIntent,
  validateSymptomPayload,
} from "../services/extractionValidator.js";
import {
  SYSTEM_PROMPT,
  INTENT_CLASSIFIER_PROMPT,
  SYMPTOM_ANALYSIS_PROMPT,
  ALTERNATIVE_PROMPT,
  APP_GUIDE_KNOWLEDGE,
  GENERAL_CHAT_PROMPT,
} from "../utils/medAgentPrompts.js";

const { getDatabase, productRepository } = repositories;

const OFFLINE_NOTE =
  "Offline mode: this answer comes from a local model and is limited to medicines in your own inventory. A pharmacist must verify every suggestion.";

// ─────────────────────────────────────────────────
// Medical safety: deterministic red-flag gate
// Applied regardless of provider, before any medicine is suggested.
// ─────────────────────────────────────────────────
const EMERGENCY_PATTERNS = [
  /\bchest pain\b/i,
  /\bchest tight(ness)?\b/i,
  /\bheart attack\b/i,
  /\bcan'?t breathe\b/i,
  /\bdifficulty breathing\b/i,
  /\bshort(ness)? of breath\b/i,
  /\bbreathless\b/i,
  /\bunconscious\b/i,
  /\bfaint(ing|ed)?\b/i,
  /\bseizure\b/i,
  /\bconvuls/i,
  /\bstroke\b/i,
  /\bparalys/i,
  /\bsevere bleeding\b/i,
  /\bbleeding (heavily|a lot)\b/i,
  /\bsuicid/i,
  /\boverdose\b/i,
  /\bpoison(ing|ed)?\b/i,
  /\b(10[4-9]|1[1-9]\d)\s*(°\s*)?f\b/i,
  /\b(4[0-9])\s*(°\s*)?c\b/i,
];

function detectEmergency(message) {
  return EMERGENCY_PATTERNS.some((pattern) => pattern.test(String(message || "")));
}

const EMERGENCY_REPLY = {
  type: "medicine_suggestion",
  condition: "Requires professional medical assessment",
  severity: "severe",
  doctorConsultRequired: true,
  message:
    "⚠️ These symptoms may require urgent medical attention. Do not suggest medicines for this — advise the customer to consult a doctor or go to the nearest hospital immediately.",
  medicines: [],
  alternatives: [],
  generalAdvice:
    "MedAgent does not provide medicine advice for potentially serious symptoms. Please direct the customer to a qualified medical professional.",
  provider: "safety-gate",
  offline: false,
  emergency: true,
};

// ─────────────────────────────────────────────────
// Deterministic intent classification (works with no AI at all)
// ─────────────────────────────────────────────────
const SYMPTOM_WORDS =
  /\b(pain|ache|fever|cough|cold|headache|migraine|acidity|heartburn|gas|vomit|nausea|diarrh|constipat|rash|allerg|infection|symptom|sore throat|sneez|dizzy|weakness|fatigue|cramp|burn|injur|itch|swelling|dehydration)\b/i;
const ALTERNATIVE_WORDS =
  /\b(alternative|alternatives|substitute|instead of|in place of|replace|equivalent|same as)\b/i;
const GUIDANCE_WORDS =
  /\b(how (do|can|to)|where (is|do|can|find)|navigate|open|go to|which page|screen|tab|dashboard|inventory|billing|order|orders|customer|customers|supplier|suppliers|import|settings|calendar|bill|bills)\b/i;

function classifyIntentOffline(message) {
  const text = String(message || "");
  if (ALTERNATIVE_WORDS.test(text)) return "alternative_request";
  if (SYMPTOM_WORDS.test(text)) return "symptom_query";
  if (GUIDANCE_WORDS.test(text)) return "app_guidance";
  return "general_chat";
}

function extractMedicineNameOffline(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  const patterns = [
    /(?:alternative|substitute|instead of|in place of|replace|equivalent)\s*(?:for|of|to)?\s+(.+)/i,
    /(?:need|want|looking for|do you have|is there|give me)\s+(.+)/i,
    /find\s+(?:an?\s+)?alternative\s+for\s+(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1]
        .replace(/\b(available|in stock|please|now|medicine|tablet|tablets|capsule|syrup)\b/gi, " ")
        .replace(/[?.!]+$/, "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  return text.replace(/[?.!]+$/, "").trim();
}

// ─────────────────────────────────────────────────
// Built-in app guide (no AI required)
// ─────────────────────────────────────────────────
const APP_GUIDE_FALLBACKS = [
  {
    match: /\b(import|scan|ai import|invoice upload)\b/i,
    message:
      "Use AI Import to read a supplier invoice and bulk-add products. Extracted rows are shown for review before anything is saved.",
    steps: [
      "Open AI Import from the sidebar",
      "Upload a PDF, JPG or PNG invoice (or record audio while online)",
      "Review and edit the extracted items",
      "Confirm the import to update stock",
    ],
    navigateTo: "/ai-import",
    pageTitle: "AI Import",
  },
  {
    match: /\b(bill|billing|sale|sell|invoice|customer bill)\b/i,
    message:
      "Billing is where you build a customer bill, add products to the cart and complete the sale.",
    steps: [
      "Open Billing and stay on the New Bill tab",
      "Search a product and add it to the cart",
      "Optionally enter the customer's mobile number",
      "Review totals, choose a payment method and complete the sale",
    ],
    navigateTo: "/billing",
    pageTitle: "Billing",
  },
  {
    match: /\b(add|new|create)\b.*\b(product|medicine|item)\b/i,
    message:
      "You can add a product from the Inventory page or with the Add New Product quick action on the Dashboard.",
    steps: [
      "Go to Inventory",
      "Choose Add Product",
      "Enter name, SKU, category, quantity and price",
      "Save the product",
    ],
    navigateTo: "/inventory",
    pageTitle: "Inventory",
  },
  {
    match: /\b(stock|inventory|low stock|expiry|expired)\b/i,
    message:
      "Inventory lists your full catalogue with stock status, and the Dashboard highlights low-stock items.",
    steps: [
      "Open Inventory to search or filter products",
      "Use the Dashboard low-stock alerts to prioritise restocking",
    ],
    navigateTo: "/inventory",
    pageTitle: "Inventory",
  },
  {
    match: /\b(purchase order|order|supplier order|restock)\b/i,
    message: "Purchase orders track supplier deliveries from Pending through to Delivered.",
    steps: [
      "Open Orders to see all purchase orders",
      "Create a purchase order with supplier and items",
      "Mark it In Transit, then Delivered to receive the stock",
    ],
    navigateTo: "/orders",
    pageTitle: "Orders",
  },
  {
    match: /\b(customer|patient|purchase history)\b/i,
    message: "The Customers page stores contact details and each customer's purchase history.",
    steps: ["Open Customers", "Search by name or mobile number", "Open a customer to view their history"],
    navigateTo: "/customers",
    pageTitle: "Customers",
  },
  {
    match: /\b(supplier|distributor|vendor)\b/i,
    message: "Suppliers keeps your distributor directory with contact details.",
    steps: ["Open Suppliers", "Add or edit a supplier", "Link the supplier when creating a purchase order"],
    navigateTo: "/suppliers",
    pageTitle: "Suppliers",
  },
  {
    match: /\b(setting|profile|account|password)\b/i,
    message: "Settings holds account and shop preferences.",
    steps: ["Open Settings", "Update your profile or shop details", "Save the changes"],
    navigateTo: "/settings",
    pageTitle: "Settings",
  },
];

function findOfflineGuide(message) {
  const text = String(message || "");
  const match = APP_GUIDE_FALLBACKS.find((entry) => entry.match.test(text));
  if (!match) return null;
  return {
    message: match.message,
    steps: match.steps,
    navigateTo: match.navigateTo,
    pageTitle: match.pageTitle,
  };
}

// ─────────────────────────────────────────────────
// Helper: Cross-reference medicines with inventory
// ─────────────────────────────────────────────────
const crossReferenceInventory = (medicines, orgId) => {
  const allProducts = productRepository.findAll(orgId);
  const now = new Date();

  return medicines.map((med) => {
    const searchTerms = [
      med.genericName?.toLowerCase(),
      ...(med.commonBrandNames || []).map((b) => b.toLowerCase()),
    ].filter(Boolean);

    let bestMatch = null;
    let bestScore = 0;

    for (const product of allProducts) {
      const productName = product.name.toLowerCase();
      for (const term of searchTerms) {
        if (productName === term) {
          bestMatch = product;
          bestScore = 100;
          break;
        }
        if (productName.includes(term) || term.includes(productName)) {
          const score =
            (Math.min(productName.length, term.length) /
              Math.max(productName.length, term.length)) *
            80;
          if (score > bestScore) {
            bestMatch = product;
            bestScore = score;
          }
        }
        const productWords = productName.split(/\s+/);
        const termWords = term.split(/\s+/);
        const overlap = productWords.filter((w) =>
          termWords.some((tw) => tw.includes(w) || w.includes(tw))
        );
        if (overlap.length > 0) {
          const score =
            (overlap.length / Math.max(productWords.length, termWords.length)) * 60;
          if (score > bestScore) {
            bestMatch = product;
            bestScore = score;
          }
        }
      }
      if (bestScore === 100) break;
    }

    if (bestMatch && bestScore >= 30) {
      const isExpired = bestMatch.expiryDate && new Date(bestMatch.expiryDate) < now;
      return {
        ...med,
        inventory: {
          available: !isExpired && bestMatch.status !== "Out of Stock",
          matchedProduct: bestMatch.name,
          productId: bestMatch._id,
          currentStock: bestMatch.quantity,
          stockStatus: isExpired ? "Expired" : bestMatch.status,
          pricePerUnit: bestMatch.price,
          expiryDate: bestMatch.expiryDate,
        },
      };
    }

    return {
      ...med,
      inventory: {
        available: false,
        matchedProduct: null,
        productId: null,
        currentStock: 0,
        stockStatus: "Not in Inventory",
        pricePerUnit: null,
        expiryDate: null,
      },
    };
  });
};

// ─────────────────────────────────────────────────
// Helper: Query Alternatives from SQLite
// ─────────────────────────────────────────────────
const findAlternativesInSqlite = (category, medicineNameToExclude, orgId, limit = 5) => {
  const db = getDatabase();
  const orgInternalId = repositories.organizationRepository.findById(orgId)?.id;
  if (!orgInternalId) return [];

  const now = new Date().toISOString();
  let query = `
    SELECT * FROM products
    WHERE organization_id = ?
      AND status != 'Out of Stock'
      AND (expiry_date IS NULL OR expiry_date > ?)
  `;
  const params = [orgInternalId, now];

  if (category && category !== "General") {
    query += " AND category LIKE ?";
    params.push(`%${category}%`);
  }

  if (medicineNameToExclude) {
    query += " AND LOWER(name) NOT LIKE ?";
    params.push(`%${medicineNameToExclude.toLowerCase()}%`);
  }

  query += ` ORDER BY quantity DESC LIMIT ${limit}`;

  const rows = db.prepare(query).all(...params);
  return rows.map((r) => productRepository.findById(r.id));
};

function sendChatError(res, error) {
  const aiError = isAIError(error) ? error : toAIError(error);
  const statusCode =
    Number.isInteger(aiError.statusCode) && aiError.statusCode >= 400 && aiError.statusCode < 600
      ? aiError.statusCode
      : 503;

  res.status(statusCode).json({
    type: "error",
    code: aiError.code,
    message: aiError.message,
    provider: aiError.provider,
  });
}

// ─────────────────────────────────────────────────
// POST /api/medagent/chat — Main chat endpoint
// ─────────────────────────────────────────────────
const handleChat = async (req, res) => {
  const { message, conversationHistory } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ message: "Message is required" });
  }

  try {
    const orgId = await getTenantContext(req);
    const db = getDatabase();
    const status = await aiProvider.getStatus();
    const online = status.capabilities.chat === "gemini";

    // ── Step 1: Intent ────────────────────────────────────────────
    let intent = null;
    if (online) {
      try {
        const classified = await aiProvider.generateText({
          prompt: INTENT_CLASSIFIER_PROMPT.replace("{MESSAGE}", message),
        });
        intent = validateIntent(classified.text);
      } catch {
        // Fall through to the deterministic classifier.
      }
    }
    if (!intent) intent = classifyIntentOffline(message);

    // Offline: a bare medicine name ("need Dolo 650") is an alternatives lookup.
    if (!online && intent === "general_chat") {
      const directHits = productRepository.search(message, orgId);
      if (directHits.length > 0) intent = "alternative_request";
    }

    // ── Step 2: Route by intent ───────────────────────────────────
    if (intent === "symptom_query") {
      if (detectEmergency(message)) {
        return res.json(EMERGENCY_REPLY);
      }

      const categoryRows = db
        .prepare(
          "SELECT DISTINCT category FROM products WHERE organization_id = ? AND category IS NOT NULL"
        )
        .all(repositories.organizationRepository.findById(orgId)?.id);
      const categories = categoryRows.map((r) => r.category);
      const categoryList = categories.length > 0 ? categories.join(", ") : "General medicines";

      const prompt = SYMPTOM_ANALYSIS_PROMPT
        .replace("{CATEGORIES}", categoryList)
        .replace("{SYMPTOMS}", message);

      let parsed;
      let provider;
      try {
        const generated = await aiProvider.generateTextJSON({
          system: SYSTEM_PROMPT,
          prompt,
          numPredict: 900,
          validate: validateSymptomPayload,
        });
        parsed = generated.data;
        provider = generated.provider;
      } catch (error) {
        return sendChatError(res, error);
      }

      const offline = provider === "local";
      let medicines = crossReferenceInventory(parsed.medicines, orgId);
      let alternatives = [];

      if (offline) {
        // A local model may name anything; only inventory-backed rows survive.
        medicines = medicines.filter((med) => med.inventory.available);
      } else {
        const outOfStock = medicines.filter(
          (m) => !m.inventory.available && m.inventory.stockStatus !== "Expired"
        );

        if (outOfStock.length > 0) {
          for (const med of outOfStock) {
            const alts = findAlternativesInSqlite(med.category, null, orgId, 3);
            if (alts.length > 0) {
              alternatives.push({
                forMedicine: med.genericName,
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
            }
          }
        }
      }

      if (offline && medicines.length === 0) {
        return res.json({
          type: "medicine_suggestion",
          condition: parsed.condition,
          severity: parsed.severity,
          doctorConsultRequired: true,
          message:
            "I could not safely match these symptoms to any medicine in your inventory while offline. Please advise the customer to consult a pharmacist or doctor.",
          medicines: [],
          alternatives: [],
          generalAdvice: parsed.generalAdvice || "",
          provider,
          offline: true,
        });
      }

      const baseMessage = parsed.doctorConsultRequired
        ? "⚠️ These symptoms may require immediate medical attention. Please advise the customer to consult a doctor."
        : `Based on the symptoms, this may be associated with ${parsed.condition}. Here are the recommended medicines:`;

      return res.json({
        type: "medicine_suggestion",
        condition: parsed.condition || "General symptoms",
        severity: parsed.severity || "mild",
        doctorConsultRequired: parsed.doctorConsultRequired || false,
        message: offline ? `${baseMessage}\n\n${OFFLINE_NOTE}` : baseMessage,
        medicines,
        alternatives,
        generalAdvice: parsed.generalAdvice || "",
        provider,
        offline,
      });
    }

    if (intent === "alternative_request") {
      let medicineName = null;

      if (online) {
        try {
          const extracted = await aiProvider.generateText({
            prompt: `From the following user message, extract the medicine name they are asking an alternative for. Return ONLY the medicine name, nothing else.\n\nUser message: "${message}"`,
            numPredict: 40,
          });
          medicineName = extracted.text.trim().replace(/^["']|["']$/g, "").split("\n")[0];
        } catch {
          // Fall through to deterministic extraction.
        }
      }

      if (!medicineName) medicineName = extractMedicineNameOffline(message);
      if (!medicineName) medicineName = message;

      const matchedProducts = productRepository.search(medicineName, orgId);
      const product = matchedProducts[0] || null;
      const category = product?.category || "General";

      const alts = findAlternativesInSqlite(category, medicineName, orgId, 5);

      if (alts.length > 0) {
        let rankedAlts = alts;
        let provider = "sqlite";

        if (online) {
          const altNames = alts
            .map((a) => `${a.name} (${a.category}, Stock: ${a.quantity}, Price: ₹${a.price})`)
            .join("\n");
          const rankPrompt = ALTERNATIVE_PROMPT
            .replace("{MEDICINE_NAME}", medicineName)
            .replace("{AVAILABLE_MEDICINES}", altNames);

          try {
            const ranking = await aiProvider.generateTextJSON({
              system: SYSTEM_PROMPT,
              prompt: rankPrompt,
              numPredict: 500,
            });

            if (Array.isArray(ranking.data) && ranking.data.length > 0) {
              rankedAlts = ranking.data
                .map((r) => {
                  const match = alts.find(
                    (a) => a.name.toLowerCase() === String(r?.name || "").toLowerCase()
                  );
                  if (match) {
                    return { ...match, suitabilityNote: r?.suitabilityNote || "" };
                  }
                  return null;
                })
                .filter(Boolean);

              const rankedNames = rankedAlts.map((r) => r.name.toLowerCase());
              const unranked = alts.filter((a) => !rankedNames.includes(a.name.toLowerCase()));
              rankedAlts = [...rankedAlts, ...unranked];
              provider = "gemini";
            }
          } catch {
            // Fallback to unranked SQLite order.
          }
        }

        return res.json({
          type: "alternative",
          originalMedicine: medicineName,
          message: `Here are available alternatives for "${medicineName}":`,
          alternatives: rankedAlts.map((a) => ({
            productId: a._id,
            name: a.name,
            category: a.category,
            currentStock: a.quantity,
            stockStatus: a.status,
            price: a.price,
            expiryDate: a.expiryDate,
            suitabilityNote: a.suitabilityNote || "",
          })),
          provider,
          offline: !online,
        });
      }

      return res.json({
        type: "alternative",
        originalMedicine: medicineName,
        message: `No alternatives found for "${medicineName}" in your current inventory. You may want to create a purchase order to restock.`,
        alternatives: [],
        provider: "sqlite",
        offline: !online,
      });
    }

    if (intent === "app_guidance") {
      try {
        const generated = await aiProvider.generateTextJSON({
          prompt: APP_GUIDE_KNOWLEDGE.replace("{QUESTION}", message),
          numPredict: 600,
          validate: validateAppGuidance,
        });

        return res.json({
          type: "app_guidance",
          message: generated.data.message || "I can help you navigate the Mediblix app!",
          steps: generated.data.steps || null,
          navigateTo: generated.data.navigateTo || null,
          pageTitle: generated.data.pageTitle || null,
          provider: generated.provider,
          offline: generated.provider === "local",
        });
      } catch (error) {
        const fallback = findOfflineGuide(message);
        if (fallback) {
          return res.json({ type: "app_guidance", ...fallback, provider: "builtin", offline: true });
        }
        return sendChatError(res, error);
      }
    }

    // General chat
    try {
      const generated = await aiProvider.generateTextJSON({
        prompt: GENERAL_CHAT_PROMPT.replace("{MESSAGE}", message),
        numPredict: 200,
      });

      return res.json({
        type: "general",
        message:
          generated.data?.message ||
          "Hi! I'm MedAgent, your AI pharmacy assistant. I can help you find medicines for symptoms, suggest alternatives, or guide you through the Mediblix app.",
        provider: generated.provider,
        offline: generated.provider === "local",
      });
    } catch {
      return res.json({
        type: "general",
        message:
          "AI assistance is unavailable right now (no Gemini connection and no local model). I can still help with inventory lookups: ask for an alternative to a medicine, or open Inventory to browse products directly.",
        provider: "builtin",
        offline: true,
      });
    }
  } catch (error) {
    console.error("MedAgent Error:", error.message);
    res.status(500).json({
      type: "error",
      message:
        "I'm having trouble processing that right now. Please try again in a moment, or browse the Inventory page directly to find medicines.",
    });
  }
};

// ─────────────────────────────────────────────────
// POST /api/medagent/alternatives — Direct alternatives lookup (SQLite only)
// ─────────────────────────────────────────────────
const getAlternatives = async (req, res) => {
  const { medicineName, category } = req.body;

  if (!medicineName) {
    return res.status(400).json({ message: "Medicine name is required" });
  }

  try {
    const orgId = await getTenantContext(req);
    const searchCategory = category || "General";
    const alts = findAlternativesInSqlite(searchCategory, medicineName, orgId, 5);

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
// GET /api/medagent/categories — List inventory categories (SQLite only)
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

export { handleChat, getAlternatives, getCategories };
