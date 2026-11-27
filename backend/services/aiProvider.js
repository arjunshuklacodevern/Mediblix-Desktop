/**
 * Mediblix Desktop — AI Provider Router & Safety Enforcement Layer
 *
 * Enforces:
 * 1. Explicit Provider Selection: Default is "local" (Ollama / Local inference).
 * 2. Absolute Isolation: When in "local" mode, NEVER contact Gemini or Google APIs,
 *    and NEVER require or read GEMINI_API_KEY.
 * 3. Layer-1 Deterministic Medical Safety: Hardcoded symptom rules for urgent conditions,
 *    preventing unsafe medicine suggestions regardless of model outputs.
 * 4. Deterministic inventory integration: SQLite remains the sole source of truth
 *    for stock counts, prices, batch numbers, and expiry dates.
 */

import { callLocalLLM, callLocalVision, extractFromPdf, transcribeAudioLocally, checkOllamaHealth, DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL } from "./localAIService.js";

// Active provider: "local" (default) or "cloud"
let activeProvider = process.env.MEDIBLIX_AI_PROVIDER || "local";

export function getActiveProvider() {
  return activeProvider;
}

export function setActiveProvider(provider) {
  if (provider !== "local" && provider !== "cloud") {
    throw new Error("Invalid provider. Must be 'local' or 'cloud'");
  }
  activeProvider = provider;
  return activeProvider;
}

// ─────────────────────────────────────────────────────────────
// Deterministic Medical Safety Keywords & Triage Rule (Layer 1)
// ─────────────────────────────────────────────────────────────
const EMERGENCY_SYMPTOMS = [
  "chest pain",
  "difficulty breathing",
  "shortness of breath",
  "breathlessness",
  "unconscious",
  "unconsciousness",
  "fainting",
  "seizure",
  "convulsion",
  "severe bleeding",
  "hemorrhage",
  "vomiting blood",
  "blood in stool",
  "stroke",
  "paralysis",
  "slurred speech",
  "facial drooping",
  "high fever",
  "fever above 104",
  "poisoning",
  "overdose",
  "anaphylaxis",
  "heart attack",
  "cardiac arrest",
  "suicide",
  "severe burns"
];

/**
 * Checks if user message contains deterministic medical emergency indicators
 */
export function detectMedicalEmergency(text) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();
  for (const keyword of EMERGENCY_SYMPTOMS) {
    if (lower.includes(keyword)) {
      return {
        isEmergency: true,
        keyword,
        reason: `Urgent medical condition detected: '${keyword}'. Emergency medical intervention required.`,
      };
    }
  }
  return { isEmergency: false };
}

/**
 * Extract and sanitize JSON from model text responses
 */
export function extractJSON(text) {
  if (!text) return null;
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

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

/**
 * Main AI Generation Router:
 * Routes to either local Ollama or cloud Gemini based on current setting.
 */
export async function callAI(prompt, systemPrompt = "", options = {}) {
  if (activeProvider === "local") {
    // STRICT OFFLINE: Zero outbound requests to Google, no API key checked
    return await callLocalLLM(prompt, systemPrompt, options.model || DEFAULT_TEXT_MODEL, options);
  } else {
    // Cloud fallback (only if user explicitly activated "cloud")
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("Cloud AI is configured, but GEMINI_API_KEY is not set.");
    }

    const parts = [];
    if (systemPrompt) parts.push({ text: systemPrompt });
    parts.push({ text: prompt });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      }
    );

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "Gemini API error");
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("No response received from cloud AI");
    }
    return text;
  }
}

/**
 * Main Vision Router for Invoices and Bills:
 */
export async function parseDocumentAI({ fileData, mimeType, prompt, isInvoice = true }) {
  if (activeProvider === "local") {
    const cleanMime = (mimeType || "").split(";")[0].trim().toLowerCase();

    // 1. Audio processing (voice dictation)
    if (cleanMime.startsWith("audio/")) {
      const buffer = Buffer.from(fileData, "base64");
      const transcript = await transcribeAudioLocally(buffer, cleanMime);
      if (!transcript || transcript.trim().length === 0) {
        throw new Error("No audible speech could be transcribed from the recording.");
      }

      // Feed transcribed speech to local LLM for structuring
      const structuredPrompt = `${prompt}\n\nHere is the transcribed audio recording: "${transcript}". Extract and format the products.`;
      const llmResponse = await callLocalLLM(structuredPrompt);
      const parsed = extractJSON(llmResponse);
      if (!parsed) {
        throw new Error("Failed to parse extracted voice recording data into structured items.");
      }
      return parsed;
    }

    // 2. PDF processing (text or scanned)
    if (cleanMime === "application/pdf") {
      const pdfBuffer = Buffer.from(fileData, "base64");
      const pdfResult = await extractFromPdf(pdfBuffer);

      if (pdfResult.type === "text") {
        // Direct text-native PDF extraction
        const structuredPrompt = `${prompt}\n\nExtracted PDF document text content:\n${pdfResult.text}`;
        const llmResponse = await callLocalLLM(structuredPrompt);
        const parsed = extractJSON(llmResponse);
        if (parsed) return parsed;
      } else if (pdfResult.type === "images" && pdfResult.images.length > 0) {
        // Scanned PDF pages rendered to PNG: analyze page 1 with vision model
        const visionResponse = await callLocalVision(pdfResult.images[0], prompt);
        const parsed = extractJSON(visionResponse);
        if (parsed) return parsed;
      }
      throw new Error("Could not extract pharmaceutical items from the provided PDF.");
    }

    // 3. Image processing (JPEG, PNG, WebP)
    const visionResponse = await callLocalVision(fileData, prompt);
    const parsed = extractJSON(visionResponse);
    if (!parsed) {
      throw new Error("Local Vision AI could not detect structured medicine items in the image.");
    }
    return parsed;
  } else {
    // Cloud Gemini route
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("Gemini API Key is not configured for cloud parsing.");
    }

    const cleanMime = mimeType.split(";")[0].trim();
    const parts = [
      {
        inlineData: {
          mimeType: cleanMime,
          data: fileData,
        },
      },
      { text: prompt },
    ];

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      }
    );

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "Cloud parsing failed");
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = extractJSON(text);
    if (!parsed) {
      throw new Error("Cloud AI response was not in a valid JSON format.");
    }
    return parsed;
  }
}

export { checkOllamaHealth };

export default {
  getActiveProvider,
  setActiveProvider,
  detectMedicalEmergency,
  extractJSON,
  callAI,
  parseDocumentAI,
  checkOllamaHealth,
};
