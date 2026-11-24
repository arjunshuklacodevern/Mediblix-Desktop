import repositories from "../../database/repositories/index.js";
import { getTenantContext } from "../utils/tenantHelper.js";
import {
  SYSTEM_PROMPT,
  INTENT_CLASSIFIER_PROMPT,
  SYMPTOM_ANALYSIS_PROMPT,
  ALTERNATIVE_PROMPT,
  APP_GUIDE_KNOWLEDGE,
  GENERAL_CHAT_PROMPT,
} from "../utils/medAgentPrompts.js";

const { getDatabase, productRepository } = repositories;

// ─────────────────────────────────────────────────
// Helper: Call Gemini API
// ─────────────────────────────────────────────────
const callGemini = async (prompt, systemPrompt = "") => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini API Key is not configured");
  }

  const parts = [];
  if (systemPrompt) {
    parts.push({ text: systemPrompt });
  }
  parts.push({ text: prompt });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
      }),
    }
  );

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || "Gemini API error");
  }

  let text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("No response from AI");
  }

  return text;
};

// ─────────────────────────────────────────────────
// Helper: Parse JSON from Gemini response
// ─────────────────────────────────────────────────
const parseGeminiJSON = (text) => {
  let cleaned = text.replace(/```json/gi, "").replace(/```/gi, "").trim();

  const objStart = cleaned.indexOf("{");
  const objEnd = cleaned.lastIndexOf("}");
  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");

  if (objStart !== -1 && objEnd > objStart && (arrStart === -1 || objStart < arrStart)) {
    cleaned = cleaned.substring(objStart, objEnd + 1);
  } else if (arrStart !== -1 && arrEnd > arrStart) {
    cleaned = cleaned.substring(arrStart, arrEnd + 1);
  }

  return JSON.parse(cleaned);
};

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
    const orgInternalId = repositories.organizationRepository.findById(orgId)?.id;
    const db = getDatabase();

    // Step 1: Classify intent
    const intentPrompt = INTENT_CLASSIFIER_PROMPT.replace("{MESSAGE}", message);
    const intentRaw = await callGemini(intentPrompt);
    const intent = intentRaw.trim().toLowerCase().replace(/[^a-z_]/g, "");

    // Step 2: Route based on intent
    if (intent === "symptom_query") {
      const categoryRows = db
        .prepare(
          "SELECT DISTINCT category FROM products WHERE organization_id = ? AND category IS NOT NULL"
        )
        .all(orgInternalId);
      const categories = categoryRows.map((r) => r.category);
      const categoryList = categories.length > 0 ? categories.join(", ") : "General medicines";

      const prompt = SYMPTOM_ANALYSIS_PROMPT
        .replace("{CATEGORIES}", categoryList)
        .replace("{SYMPTOMS}", message);

      const aiResponse = await callGemini(prompt, SYSTEM_PROMPT);
      const parsed = parseGeminiJSON(aiResponse);

      let medicines = [];
      let alternatives = [];

      if (parsed.medicines && parsed.medicines.length > 0) {
        medicines = crossReferenceInventory(parsed.medicines, orgId);

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

      return res.json({
        type: "medicine_suggestion",
        condition: parsed.condition || "General symptoms",
        severity: parsed.severity || "mild",
        doctorConsultRequired: parsed.doctorConsultRequired || false,
        message: parsed.doctorConsultRequired
          ? "⚠️ These symptoms may require immediate medical attention. Please advise the customer to consult a doctor."
          : `Based on the symptoms, this may be associated with ${parsed.condition}. Here are the recommended medicines:`,
        medicines,
        alternatives,
        generalAdvice: parsed.generalAdvice || "",
      });
    }

    if (intent === "alternative_request") {
      const prompt = `From the following user message, extract the medicine name they are asking an alternative for. Return ONLY the medicine name, nothing else.\n\nUser message: "${message}"`;
      const medicineName = (await callGemini(prompt)).trim();

      const matchedProducts = productRepository.search(medicineName, orgId);
      const product = matchedProducts[0] || null;
      const category = product?.category || "General";

      const alts = findAlternativesInSqlite(category, medicineName, orgId, 5);

      if (alts.length > 0) {
        const altNames = alts
          .map((a) => `${a.name} (${a.category}, Stock: ${a.quantity}, Price: ₹${a.price})`)
          .join("\n");
        const rankPrompt = ALTERNATIVE_PROMPT
          .replace("{MEDICINE_NAME}", medicineName)
          .replace("{AVAILABLE_MEDICINES}", altNames);

        let rankedAlts = alts;
        try {
          const rankResponse = await callGemini(rankPrompt, SYSTEM_PROMPT);
          const ranking = parseGeminiJSON(rankResponse);

          if (Array.isArray(ranking) && ranking.length > 0) {
            rankedAlts = ranking
              .map((r) => {
                const match = alts.find(
                  (a) => a.name.toLowerCase() === r.name?.toLowerCase()
                );
                if (match) {
                  return { ...match, suitabilityNote: r.suitabilityNote || "" };
                }
                return null;
              })
              .filter(Boolean);

            const rankedNames = rankedAlts.map((r) => r.name.toLowerCase());
            const unranked = alts.filter(
              (a) => !rankedNames.includes(a.name.toLowerCase())
            );
            rankedAlts = [...rankedAlts, ...unranked];
          }
        } catch {
          // Fallback to default ranking
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
        });
      }

      return res.json({
        type: "alternative",
        originalMedicine: medicineName,
        message: `No alternatives found for "${medicineName}" in your current inventory. You may want to create a purchase order to restock.`,
        alternatives: [],
      });
    }

    if (intent === "app_guidance") {
      const prompt = APP_GUIDE_KNOWLEDGE.replace("{QUESTION}", message);
      const aiResponse = await callGemini(prompt);
      const parsed = parseGeminiJSON(aiResponse);

      return res.json({
        type: "app_guidance",
        message: parsed.message || "I can help you navigate the Mediblix app!",
        steps: parsed.steps || null,
        navigateTo: parsed.navigateTo || null,
        pageTitle: parsed.pageTitle || null,
      });
    }

    // General chat
    const prompt = GENERAL_CHAT_PROMPT.replace("{MESSAGE}", message);
    const aiResponse = await callGemini(prompt);
    const parsed = parseGeminiJSON(aiResponse);

    return res.json({
      type: "general",
      message:
        parsed.message ||
        "Hi! I'm MedAgent, your AI pharmacy assistant. I can help you find medicines for symptoms, suggest alternatives, or guide you through the Mediblix app. What would you like help with?",
    });
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

export { handleChat, getAlternatives, getCategories };
