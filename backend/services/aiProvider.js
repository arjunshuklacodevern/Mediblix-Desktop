/**
 * Mediblix Desktop — Shared AI provider router
 *
 * One place decides which AI answers a request:
 *
 *   internet + Gemini configured + not cooling down  ──► Gemini (online, preferred)
 *   otherwise, bundled llama.cpp runtime + model       ──► local model (offline)
 *   neither                                           ──► typed AIError (never fake success)
 *
 * Controllers call this only for *generation*. Parsing results are validated by
 * extractionValidator, and business writes stay in the existing SQLite
 * controllers — no model ever touches the database.
 */

import { AI_ERROR, AIError, isAIError, toAIError } from "./aiErrors.js";
import geminiService from "./geminiService.js";
import localAIService from "./localAIService.js";
import documentProcessor from "./documentProcessor.js";
import { parseLooseJSON } from "./extractionValidator.js";

const INTERNET_CACHE_MS = 15000;
const GEMINI_COOLDOWN_SHORT_MS = 60000;
const GEMINI_COOLDOWN_LONG_MS = 5 * 60 * 1000;
const GEMINI_PROBE_URL = "https://generativelanguage.googleapis.com/";
const GEMINI_TIMEOUT_MS = Number(process.env.MEDIBLIX_GEMINI_TIMEOUT_MS || 45000);

let internetCache = { at: 0, value: null };
let geminiCooldown = { until: 0, code: null, message: null };
let lastLocalSlot = null;

/**
 * Keeps only one local model resident at a time on memory-constrained
 * machines (16 GB class): using the vision model releases the text model.
 * Disable with MEDIBLIX_LOCAL_SINGLE_MODEL=0.
 */
async function prepareLocalSlot(kind) {
  const singleModel = String(process.env.MEDIBLIX_LOCAL_SINGLE_MODEL ?? "1") !== "0";
  if (!singleModel || !kind) return;
  if (lastLocalSlot && lastLocalSlot !== kind) {
    await localAIService.unloadModel(lastLocalSlot).catch(() => {});
  }
  lastLocalSlot = kind;
}

/**
 * True when the machine can reach Google's API host.
 * `null` means "not probed yet".
 */
export async function probeInternet({ force = false } = {}) {
  const now = Date.now();
  if (!force && internetCache.value !== null && now - internetCache.at < INTERNET_CACHE_MS) {
    return internetCache.value;
  }

  let reachable = false;
  try {
    // Any HTTP answer — including a 4xx — proves the host is reachable.
    await fetch(GEMINI_PROBE_URL, { signal: AbortSignal.timeout(2500) });
    reachable = true;
  } catch {
    reachable = false;
  }

  internetCache = { at: now, value: reachable };
  return reachable;
}

export function resetCaches() {
  internetCache = { at: 0, value: null };
  geminiCooldown = { until: 0, code: null, message: null };
  localAIService.resetHealthCache();
}

function geminiCoolingDown() {
  return Date.now() < geminiCooldown.until;
}

function markGeminiFailure(error) {
  if (!error?.code) return;
  const long = error.code === AI_ERROR.GEMINI_AUTH.code || error.code === AI_ERROR.GEMINI_QUOTA.code;
  geminiCooldown = {
    until: Date.now() + (long ? GEMINI_COOLDOWN_LONG_MS : GEMINI_COOLDOWN_SHORT_MS),
    code: error.code,
    message: error.message,
  };
}

function clearGeminiFailure() {
  if (geminiCooldown.until !== 0) {
    geminiCooldown = { until: 0, code: null, message: null };
  }
}

/**
 * Reports the current AI environment. Safe to expose to the UI: no secrets.
 */
export async function getStatus({ force = false, probe = false } = {}) {
  const [internet, local] = await Promise.all([
    probeInternet({ force }),
    localAIService.checkHealth({ force }),
  ]);

  // `probe` actually runs one token of inference, proving the runtime engine
  // works — a daemon can answer HTTP while its engine is broken.
  const inferenceProbe = probe ? await localAIService.probeInference({ force }) : null;

  const configured = geminiService.isConfigured();
  const cooling = geminiCoolingDown();

  const geminiReady = configured && internet && !cooling;
  const localChatReady = local.available && local.textModelReady;
  const localDocumentReady = local.available && (local.textModelReady || local.visionModelReady);

  return {
    internet,
    gemini: {
      configured,
      model: geminiService.getModel(),
      reachable: internet,
      available: geminiReady,
      coolingDown: cooling,
      cooldownCode: cooling ? geminiCooldown.code : null,
      cooldownMessage: cooling ? geminiCooldown.message : null,
    },
    local: {
      backend: local.backend,
      available: local.available,
      url: local.url,
      version: local.version,
      models: local.models,
      textModel: local.textModel,
      visionModel: local.visionModel,
      textModelReady: local.textModelReady,
      visionModelReady: local.visionModelReady,
      runtimeInstalled: local.runtimeInstalled,
      setupRequired: local.setupRequired,
      modelDir: local.modelDir,
      missing: local.missing,
      disabled: local.disabled,
      error: local.error,
      inferenceProbe,
      singleModelMode: String(process.env.MEDIBLIX_LOCAL_SINGLE_MODEL ?? "1") !== "0",
      tier: localAIService.getConfig().tier,
      visionCapability: localAIService.getVisionCapability(),
      scan: localAIService.getScanPipeline(),
    },
    preferred: geminiReady ? "gemini" : localDocumentReady ? "local" : null,
    capabilities: {
      chat: geminiReady ? "gemini" : localChatReady ? "local" : null,
      document: geminiReady ? "gemini" : localDocumentReady ? "local" : null,
      audio: geminiReady ? "gemini" : null,
    },
  };
}

function describeLocalShortfall(status) {
  if (status.local.disabled) return "offline AI is switched off in the app settings";
  if (status.local.runtimeInstalled === false) {
    return "the bundled offline AI runtime is missing from this installation";
  }
  if (!status.local.textModelReady && !status.local.visionModelReady) {
    return status.local.setupRequired
      ? "the offline AI models have not been downloaded yet"
      : "the offline AI models are not installed";
  }
  if (!status.local.available) return status.local.error || "the offline AI runtime is not available";
  return null;
}

function unavailableMessage(status, reasons, { needVision = false } = {}) {
  const parts = [];

  if (!status.gemini.configured) {
    parts.push("online AI (Gemini) is not configured because GEMINI_API_KEY is missing");
  } else if (!status.internet) {
    parts.push("online AI (Gemini) needs an internet connection, which is not available");
  } else if (status.gemini.coolingDown) {
    parts.push(`online AI (Gemini) is paused after an error: ${status.gemini.cooldownMessage || status.gemini.cooldownCode}`);
  } else if (reasons.gemini) {
    parts.push(`online AI (Gemini) failed: ${reasons.gemini.message}`);
  }

  const localShortfall = describeLocalShortfall(status);
  if (localShortfall) {
    parts.push(localShortfall);
  } else if (needVision && !status.local.visionModelReady) {
    parts.push(`offline AI needs the vision model "${status.local.visionModel}", which is not installed`);
  } else if (reasons.local) {
    parts.push(`offline AI failed: ${reasons.local.message}`);
  }

  return `AI is not available right now: ${parts.join("; ")}.`;
}

function nameTokens(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length >= 4 && !/^\d+$/.test(token));
}

/**
 * How many extracted item names appear in the text the model was given.
 * Deliberately lenient (one distinctive token is enough) because the model
 * normalises names, but strict enough to catch wholesale invention.
 */
function countGroundedItems(data, transcript) {
  const haystack = String(transcript || "").toLowerCase();
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  let grounded = 0;
  for (const item of items) {
    const tokens = nameTokens(item?.name);
    if (tokens.length === 0) continue;
    if (tokens.some((token) => haystack.includes(token))) grounded += 1;
  }
  return grounded;
}

function isClientInputError(error) {
  return (
    error?.code === AI_ERROR.INPUT_REQUIRED.code ||
    error?.code === AI_ERROR.INPUT_INVALID.code ||
    error?.code === AI_ERROR.INPUT_TOO_LARGE.code ||
    error?.code === AI_ERROR.INPUT_UNSUPPORTED.code ||
    error?.code === AI_ERROR.OFFLINE_UNSUPPORTED.code ||
    error?.code === AI_ERROR.PDF_SUPPORT_MISSING.code
  );
}

// ─────────────────────────────────────────────────
// Document extraction (invoice + bill)
// ─────────────────────────────────────────────────

/**
 * Runs document extraction through the best available provider and validates
 * the result. Returns the provider that actually answered so the UI can show it.
 *
 * @param {object} params
 * @param {string} params.prompt         feature prompt (same text for both providers)
 * @param {Array}  params.inputs         documentProcessor.normalizeInputs() result
 * @param {Function} params.validate     validator returning the normalised value
 * @param {string} [params.feature]      'invoice' | 'bill' (used for messaging)
 */
export async function generateDocumentJSON({ prompt, inputs, validate, feature = "document" }) {
  const status = await getStatus();
  const reasons = { gemini: null, local: null };
  let localNeedVision = false;

  if (!status.gemini.available && !status.local.available) {
    throw new AIError(
      AI_ERROR.UNAVAILABLE,
      unavailableMessage(status, reasons),
      { details: { reasons: buildReasonList(status, reasons) } }
    );
  }

  // ── 1. Online provider (preferred) ────────────────────────────────
  if (status.gemini.available) {
    try {
      const parts = geminiService.buildParts(documentProcessor.toGeminiParts(inputs), prompt);
      const { text, model } = await geminiService.generateContent({
        parts,
        timeoutMs: GEMINI_TIMEOUT_MS,
      });
      const data = validate(parseLooseJSON(text));
      clearGeminiFailure();
      return { data, provider: "gemini", model, fallbackReason: null };
    } catch (error) {
      const aiError = toAIError(error);
      if (isClientInputError(aiError)) throw aiError;
      reasons.gemini = { code: aiError.code, message: aiError.message };
      markGeminiFailure(aiError);
    }
  }

  // ── 2. Offline provider ──────────────────────────────────────────
  if (status.local.available) {
    try {
      const scan = localAIService.getScanPipeline();
      const prepared = await documentProcessor.prepareForLocal(inputs, { ocr: scan.ocrEnabled });
      localNeedVision = prepared.mode !== "text";

      // Scanned pages on the Lite tier: OCR reads the page, the text model
      // writes the JSON. The OCR model is unloaded first so an 8 GB machine
      // never holds both models at once.
      if (prepared.mode === "ocr") {
        const ocr = await localAIService.ocrImages(prepared.images, {
          prompt: scan.prompt,
          maxTokens: scan.maxTokens,
        });

        await localAIService.unloadModel("vision").catch(() => {});
        await prepareLocalSlot("text");

        const ocrPrompt = `${prompt}\n\nDOCUMENT TEXT (transcribed from page images by OCR; recognition errors are possible):\n${ocr.text}`;
        const extracted = await localAIService.chatJSON({
          prompt: ocrPrompt,
          numPredict: 1600,
          kind: "text",
        });

        const data = validate(extracted.data);
        const grounded = countGroundedItems(data, ocr.text);
        const itemCount = Array.isArray(data) ? data.length : Array.isArray(data?.items) ? data.items.length : 0;

        // The text model can invent plausible medicines. If not one extracted
        // name appears on the transcribed page, the result is not trustworthy
        // enough to put in front of a pharmacist.
        if (itemCount > 0 && grounded === 0) {
          throw new AIError(
            AI_ERROR.INVALID_OUTPUT,
            "The offline model read the page but none of the extracted items could be matched back to its text. Nothing was returned. Try a clearer scan or a digital PDF.",
            { provider: "local", details: { items: itemCount, grounded, model: extracted.model } }
          );
        }

        return {
          data,
          provider: "local",
          model: extracted.model,
          fallbackReason: reasons.gemini ? reasons.gemini.code : null,
          mode: "ocr",
          durationMs: (ocr.durationMs || 0) + (extracted.durationMs || 0),
          ocr: {
            model: ocr.model,
            pages: ocr.pages,
            readPages: ocr.readPages,
            items: itemCount,
            grounded,
          },
        };
      }

      // The bundled second model is a reader, not a general VLM. Asking it to
      // answer the extraction prompt directly would produce garbage, so refuse
      // clearly instead of pretending the feature works.
      if (prepared.mode === "vision" && localAIService.getVisionCapability() === "ocr") {
        throw new AIError(
          AI_ERROR.OFFLINE_UNSUPPORTED,
          "Offline reading of scanned documents is not enabled in this build yet. Digital PDF invoices work offline; connect to the internet to read scans or photos.",
          { provider: "local", details: { kind: "vision", reason: "ocr-pipeline-disabled" } }
        );
      }

      await prepareLocalSlot(localNeedVision ? "vision" : "text");

      const localPrompt =
        prepared.mode === "text"
          ? `${prompt}\n\nDOCUMENT TEXT:\n${prepared.text}`
          : `${prompt}\n\nThe content is provided as page images. Read every line item carefully.`;

      const result = await localAIService.chatJSON({
        prompt: localPrompt,
        images: prepared.mode === "vision" ? prepared.images : null,
        numPredict: prepared.mode === "vision" ? 1400 : 1600,
        kind: prepared.mode === "vision" ? "vision" : "text",
      });

      const data = validate(result.data);
      return {
        data,
        provider: "local",
        model: result.model,
        fallbackReason: reasons.gemini ? reasons.gemini.code : null,
        mode: prepared.mode,
        durationMs: result.durationMs,
      };
    } catch (error) {
      const aiError = toAIError(error);
      if (isClientInputError(aiError)) throw aiError;
      reasons.local = {
        code: aiError.code,
        message: aiError.message,
        needsVisionModel: localNeedVision || /vision model/i.test(aiError.message || ""),
      };
    }
  } else {
    reasons.local = { code: AI_ERROR.LOCAL_UNAVAILABLE.code, message: describeLocalShortfall(status) };
  }

  // ── 3. Neither provider produced usable output ───────────────────
  const combined = new AIError(
    AI_ERROR.UNAVAILABLE,
    unavailableMessage(status, reasons, { needVision: Boolean(reasons.local?.needsVisionModel) || localNeedVision }),
    { details: { reasons: buildReasonList(status, reasons), feature } }
  );
  combined.cause = reasons.gemini || reasons.local;
  throw combined;
}

function buildReasonList(status, reasons) {
  const list = [];
  if (reasons.gemini) list.push({ provider: "gemini", ...reasons.gemini });
  if (reasons.local) list.push({ provider: "local", ...reasons.local });
  if (list.length === 0) {
    if (!status.gemini.configured) {
      list.push({ provider: "gemini", code: AI_ERROR.GEMINI_NOT_CONFIGURED.code, message: "GEMINI_API_KEY is missing" });
    } else if (!status.internet) {
      list.push({ provider: "gemini", code: AI_ERROR.OFFLINE.code, message: "No internet connection" });
    }
    if (!status.local.available) {
      list.push({ provider: "local", code: AI_ERROR.LOCAL_UNAVAILABLE.code, message: status.local.error || "Offline AI runtime not reachable" });
    }
  }
  return list;
}

// ─────────────────────────────────────────────────
// Text generation (MedAgent)
// ─────────────────────────────────────────────────

/**
 * JSON-mode text generation with online-first, offline-fallback behaviour.
 */
export async function generateTextJSON({ system, prompt, numPredict = 700, validate = null }) {
  const status = await getStatus();
  const reasons = { gemini: null, local: null };

  if (status.gemini.available) {
    try {
      const { text, model } = await geminiService.generateContent({
        parts: [{ text: system ? `${system}\n\n${prompt}` : prompt }],
        timeoutMs: GEMINI_TIMEOUT_MS,
      });
      const parsed = parseLooseJSON(text);
      clearGeminiFailure();
      return {
        data: validate ? validate(parsed) : parsed,
        text,
        provider: "gemini",
        model,
        fallbackReason: null,
      };
    } catch (error) {
      const aiError = toAIError(error);
      reasons.gemini = { code: aiError.code, message: aiError.message };
      markGeminiFailure(aiError);
    }
  }

  if (status.local.available && status.local.textModelReady) {
    try {
      await prepareLocalSlot("text");
      const result = await localAIService.chatJSON({ system, prompt, numPredict, kind: "text" });
      return {
        data: validate ? validate(result.data) : result.data,
        text: result.text,
        provider: "local",
        model: result.model,
        fallbackReason: reasons.gemini ? reasons.gemini.code : null,
        durationMs: result.durationMs,
      };
    } catch (error) {
      const aiError = toAIError(error);
      reasons.local = { code: aiError.code, message: aiError.message };
    }
  } else if (!status.local.available) {
    reasons.local = { code: AI_ERROR.LOCAL_UNAVAILABLE.code, message: describeLocalShortfall(status) };
  }

  const error = new AIError(AI_ERROR.UNAVAILABLE, unavailableMessage(status, reasons), {
    details: { reasons: buildReasonList(status, reasons) },
  });
  error.cause = reasons.gemini || reasons.local;
  throw error;
}

/**
 * Plain-text generation (intent classification, short answers).
 */
export async function generateText({ system, prompt, numPredict = 120 }) {
  const status = await getStatus();
  const reasons = { gemini: null, local: null };

  if (status.gemini.available) {
    try {
      const { text, provider, model } = await geminiService.generateContent({
        parts: [{ text: system ? `${system}\n\n${prompt}` : prompt }],
        timeoutMs: GEMINI_TIMEOUT_MS,
      });
      clearGeminiFailure();
      return { text, provider, model, fallbackReason: null };
    } catch (error) {
      const aiError = toAIError(error);
      reasons.gemini = { code: aiError.code, message: aiError.message };
      markGeminiFailure(aiError);
    }
  }

  if (status.local.available && status.local.textModelReady) {
    try {
      await prepareLocalSlot("text");
      const result = await localAIService.chatText({ system, prompt, numPredict });
      return {
        text: result.text,
        provider: "local",
        model: result.model,
        fallbackReason: reasons.gemini ? reasons.gemini.code : null,
      };
    } catch (error) {
      const aiError = toAIError(error);
      reasons.local = { code: aiError.code, message: aiError.message };
    }
  } else if (!status.local.available) {
    reasons.local = { code: AI_ERROR.LOCAL_UNAVAILABLE.code, message: describeLocalShortfall(status) };
  }

  const error = new AIError(AI_ERROR.UNAVAILABLE, unavailableMessage(status, reasons), {
    details: { reasons: buildReasonList(status, reasons) },
  });
  error.cause = reasons.gemini || reasons.local;
  throw error;
}

/**
 * Downloads an allowlisted model through the local runtime, reporting progress.
 */
export async function installModel(kind, onProgress) {
  return localAIService.installModel(kind, onProgress);
}

export default {
  getStatus,
  probeInternet,
  resetCaches,
  generateDocumentJSON,
  generateTextJSON,
  generateText,
  installModel,
};
