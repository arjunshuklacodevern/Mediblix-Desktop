/**
 * Centralized Hybrid AI Router
 *
 * Coordinates between:
 *  - Offline AI Engine (local SQLite, clinical heuristics, FAQ/app guidance)
 *  - Online AI Engine (AWS API Gateway / Cloud AI Provider)
 *
 * Implements:
 *  - Dynamic intent detection & routing
 *  - Connectivity & gateway health evaluation
 *  - Automatic fallback on network failure or timeout
 *  - Unified, consistent response schema across all modes
 */

import offlineAiEngine from "./offlineAiEngine.js";
import onlineAiEngine from "./onlineAiEngine.js";
import repositories from "../../../database/repositories/index.js";
import {
  SYSTEM_PROMPT,
  INTENT_CLASSIFIER_PROMPT,
  SYMPTOM_ANALYSIS_PROMPT,
  ALTERNATIVE_PROMPT,
  APP_GUIDE_KNOWLEDGE,
  GENERAL_CHAT_PROMPT,
} from "../../utils/medAgentPrompts.js";

const { getDatabase, productRepository } = repositories;

/**
 * Extracts and cleans JSON from AI model text responses
 */
const parseCleanJson = (text) => {
  if (typeof text === "object" && text !== null) return text;
  let cleaned = String(text).replace(/```json/gi, "").replace(/```/gi, "").trim();

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

/**
 * Returns current hybrid status for UI indicators & diagnostics
 */
export const getHybridStatus = () => {
  const onlineConfig = onlineAiEngine.getOnlineConfig();
  return {
    offlineReady: true,
    onlineConfigured: onlineConfig.isConfigured,
    provider: onlineConfig.provider,
    activeMode: onlineConfig.isConfigured ? "online" : "offline",
    localCapabilities: [
      "symptom_otc_matching",
      "sqlite_inventory_cross_reference",
      "sqlite_alternatives_discovery",
      "inventory_stock_valuation",
      "reorder_forecasting",
      "app_navigation_guidance",
    ],
    cloudCapabilities: [
      "advanced_generative_symptom_reasoning",
      "multimodal_invoice_ocr",
      "audio_bill_transcription",
    ],
  };
};

/**
 * Routes Chat messages between Online AI and Offline Local AI
 */
export const routeChat = async (message, conversationHistory, orgId) => {
  const onlineConfig = onlineAiEngine.getOnlineConfig();
  const localIntent = offlineAiEngine.classifyIntentLocal(message);

  // 1. Critical Emergency Triage is ALWAYS verified locally first
  const triage = offlineAiEngine.checkEmergencyTriage(message);
  if (triage.isEmergency) {
    return offlineAiEngine.processOfflineChat(message, orgId);
  }

  // 2. High-speed local tasks (Inventory insights & deterministic navigation)
  if (localIntent === "inventory_insights") {
    return offlineAiEngine.processOfflineChat(message, orgId);
  }

  // 3. If online is NOT configured, use Offline Local AI immediately
  if (!onlineConfig.isConfigured) {
    return offlineAiEngine.processOfflineChat(message, orgId);
  }

  // 4. Try Online AI Execution with Automatic Fallback
  try {
    const orgInternalId = repositories.organizationRepository.findById(orgId)?.id;
    const db = getDatabase();

    // Step A: Classify Intent online
    let intent = localIntent;
    try {
      const intentPrompt = INTENT_CLASSIFIER_PROMPT.replace("{MESSAGE}", message);
      const intentRes = await onlineAiEngine.callCloudAi({
        prompt: intentPrompt,
        action: "classify_intent",
        timeoutMs: 4000,
      });
      intent = intentRes.text.trim().toLowerCase().replace(/[^a-z_]/g, "");
    } catch {
      // Fallback to local classified intent
      intent = localIntent;
    }

    // Step B: Route by intent in online mode
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

      const aiResponse = await onlineAiEngine.callCloudAi({
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        action: "symptom_query",
        timeoutMs: 8000,
      });

      const parsed = parseCleanJson(aiResponse.text);

      let medicines = [];
      let alternatives = [];

      if (parsed.medicines && parsed.medicines.length > 0) {
        medicines = offlineAiEngine.crossReferenceWithSqlite(parsed.medicines, orgId);

        const outOfStock = medicines.filter(
          (m) => !m.inventory.available && m.inventory.stockStatus !== "Expired"
        );

        if (outOfStock.length > 0) {
          for (const med of outOfStock) {
            const alts = offlineAiEngine.findSqliteAlternatives(med.category, null, orgId, 3);
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

      return {
        mode: "online",
        provider: aiResponse.provider,
        fallbackApplied: false,
        type: "medicine_suggestion",
        condition: parsed.condition || "General symptoms",
        severity: parsed.severity || "mild",
        doctorConsultRequired: parsed.doctorConsultRequired || false,
        message: parsed.doctorConsultRequired
          ? "⚠️ These symptoms may require immediate medical attention. Please advise the customer to consult a doctor."
          : `[Cloud AI] Based on the symptoms, this may be associated with ${parsed.condition}:`,
        medicines,
        alternatives,
        generalAdvice: parsed.generalAdvice || "",
      };
    }

    if (intent === "alternative_request") {
      let medicineName = message.replace(/(find|alternative|substitute|for|need|show|me)/gi, "").trim();
      try {
        const extractPrompt = `From the following user message, extract the medicine name they are asking an alternative for. Return ONLY the medicine name, nothing else.\n\nUser message: "${message}"`;
        const res = await onlineAiEngine.callCloudAi({ prompt: extractPrompt, timeoutMs: 4000 });
        if (res.text.trim()) medicineName = res.text.trim();
      } catch {
        // use regex extracted
      }

      const matchedProducts = productRepository.search(medicineName, orgId);
      const product = matchedProducts[0] || null;
      const category = product?.category || "General";

      const alts = offlineAiEngine.findSqliteAlternatives(category, medicineName, orgId, 5);

      if (alts.length > 0) {
        let rankedAlts = alts;
        try {
          const altNames = alts
            .map((a) => `${a.name} (${a.category}, Stock: ${a.quantity}, Price: ₹${a.price})`)
            .join("\n");
          const rankPrompt = ALTERNATIVE_PROMPT
            .replace("{MEDICINE_NAME}", medicineName)
            .replace("{AVAILABLE_MEDICINES}", altNames);

          const rankRes = await onlineAiEngine.callCloudAi({
            prompt: rankPrompt,
            systemPrompt: SYSTEM_PROMPT,
            timeoutMs: 5000,
          });
          const ranking = parseCleanJson(rankRes.text);

          if (Array.isArray(ranking) && ranking.length > 0) {
            rankedAlts = ranking
              .map((r) => {
                const match = alts.find((a) => a.name.toLowerCase() === r.name?.toLowerCase());
                if (match) return { ...match, suitabilityNote: r.suitabilityNote || "" };
                return null;
              })
              .filter(Boolean);
            const rankedNames = rankedAlts.map((r) => r.name.toLowerCase());
            const unranked = alts.filter((a) => !rankedNames.includes(a.name.toLowerCase()));
            rankedAlts = [...rankedAlts, ...unranked];
          }
        } catch {
          // Keep default SQLite ranking
        }

        return {
          mode: "online",
          provider: onlineConfig.provider,
          fallbackApplied: false,
          type: "alternative",
          originalMedicine: medicineName,
          message: `[Cloud AI] Available alternatives for "${medicineName}":`,
          alternatives: rankedAlts.map((a) => ({
            productId: a._id,
            name: a.name,
            category: a.category,
            currentStock: a.quantity,
            stockStatus: a.status,
            price: a.price,
            expiryDate: a.expiryDate,
            suitabilityNote: a.suitabilityNote || `In stock: ${a.quantity} units`,
          })),
        };
      }

      return {
        mode: "online",
        provider: onlineConfig.provider,
        fallbackApplied: false,
        type: "alternative",
        originalMedicine: medicineName,
        message: `No alternatives found for "${medicineName}" in your current inventory. You may want to create a purchase order to restock.`,
        alternatives: [],
      };
    }

    if (intent === "app_guidance") {
      const prompt = APP_GUIDE_KNOWLEDGE.replace("{QUESTION}", message);
      const aiResponse = await onlineAiEngine.callCloudAi({ prompt, timeoutMs: 5000 });
      const parsed = parseCleanJson(aiResponse.text);

      return {
        mode: "online",
        provider: aiResponse.provider,
        fallbackApplied: false,
        type: "app_guidance",
        message: parsed.message || "I can help you navigate the Mediblix app!",
        steps: parsed.steps || null,
        navigateTo: parsed.navigateTo || null,
        pageTitle: parsed.pageTitle || null,
      };
    }

    // General Chat
    const prompt = GENERAL_CHAT_PROMPT.replace("{MESSAGE}", message);
    const aiResponse = await onlineAiEngine.callCloudAi({ prompt, timeoutMs: 5000 });
    const parsed = parseCleanJson(aiResponse.text);

    return {
      mode: "online",
      provider: aiResponse.provider,
      fallbackApplied: false,
      type: "general",
      message:
        parsed.message ||
        "Hi! I'm MedAgent, your AI pharmacy assistant. I can help you find medicines for symptoms, suggest alternatives, or guide you through the Mediblix app.",
    };
  } catch (error) {
    console.warn("[Hybrid AI Router] Cloud execution failed or timed out. Falling back to Local Offline AI:", error.message);
    const offlineResult = await offlineAiEngine.processOfflineChat(message, orgId);
    return {
      ...offlineResult,
      fallbackApplied: true,
      fallbackReason: error.message,
    };
  }
};

/**
 * Routes Document Parsing (Invoices & Bills)
 */
export const routeDocumentParsing = async (payload, documentType = "invoice") => {
  const onlineConfig = onlineAiEngine.getOnlineConfig();

  // If online cloud is not configured or available:
  if (!onlineConfig.isConfigured) {
    return {
      success: false,
      mode: "offline",
      isOfflineFallback: true,
      message:
        "Document OCR and AI invoice ingestion require Cloud AI or an AWS Gateway connection. In offline mode, please use standard CSV / Excel catalog import or manual product entry.",
      fallbackOption: {
        template: "CSV / Excel Bulk Import",
        suggestedRoute: "/ai-import",
      },
    };
  }

  try {
    const cloudResult = await onlineAiEngine.parseDocumentCloud({
      ...payload,
      documentType,
      timeoutMs: 15000,
    });

    const parsed = parseCleanJson(cloudResult.text);
    return {
      success: true,
      mode: "online",
      provider: cloudResult.provider,
      data: parsed,
    };
  } catch (error) {
    console.warn("[Hybrid AI Router] Cloud document parsing failed:", error.message);
    return {
      success: false,
      mode: "offline",
      isOfflineFallback: true,
      message: `Cloud OCR parsing was unavailable (${error.message}). Please use manual entry or CSV bulk import.`,
      fallbackOption: {
        template: "CSV / Excel Bulk Import",
        suggestedRoute: "/ai-import",
      },
    };
  }
};

export default {
  getHybridStatus,
  routeChat,
  routeDocumentParsing,
  getOfflineInventoryInsights: offlineAiEngine.getOfflineInventoryInsights,
  findSqliteAlternatives: offlineAiEngine.findSqliteAlternatives,
};
