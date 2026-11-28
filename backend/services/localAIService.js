/**
 * Mediblix Desktop — Local AI service (bundled llama.cpp runtime)
 *
 * The offline provider. It talks to the `llama-server` processes that Mediblix
 * itself ships and manages — never to Ollama, never to a developer install.
 *
 * Two things are separated on purpose:
 *
 *   1. Lifecycle — starting, reusing and unloading model processes. That is
 *      owned by the Electron main process (see electron/ai-control-server.js),
 *      because only the process that spawned a child may signal it.
 *   2. Inference — POST /v1/chat/completions on the slot's loopback URL.
 *
 * Configuration (all optional):
 *   MEDIBLIX_AI_CONTROL_URL / MEDIBLIX_AI_CONTROL_TOKEN  Electron control channel
 *   MEDIBLIX_LOCAL_AI_BASE_URL                           direct slot URL (dev/tests)
 *   MEDIBLIX_LOCAL_AI_VISION_BASE_URL                     direct vision slot URL
 *   MEDIBLIX_MODEL_DIR                                   where GGUF files live
 *   MEDIBLIX_LOCAL_AI=off                                disable offline AI
 */

import { AI_ERROR, AIError, toAIError } from "./aiErrors.js";
import { parseLooseJSON } from "./extractionValidator.js";
import modelManager from "./modelManager.js";

const HEALTH_CACHE_MS = 4000;
const PROBE_CACHE_MS = 60000;
const DEFAULT_TEXT_TIMEOUT_MS = 120000;
const DEFAULT_VISION_TIMEOUT_MS = 240000;

let healthCache = { at: 0, value: null };
let probeCache = { at: 0, value: null };

export function getConfig() {
  let catalog = null;
  try {
    catalog = modelManager.getCatalog();
  } catch {
    catalog = null;
  }

  let scan = null;
  try {
    scan = modelManager.getScanPipeline();
  } catch {
    scan = { mode: "direct", ocrEnabled: false, experimental: true, prompt: "OCR:", maxTokens: 2048, pageRetries: 1, maxPages: 5 };
  }

  const tierId = process.env.MEDIBLIX_AI_TIER || catalog?.defaultTier || null;
  const tierModels = catalog?.tiers?.[tierId]?.models || catalog?.models || {};

  return {
    controlUrl: (process.env.MEDIBLIX_AI_CONTROL_URL || "").replace(/\/+$/, ""),
    controlToken: process.env.MEDIBLIX_AI_CONTROL_TOKEN || "",
    directTextUrl: (process.env.MEDIBLIX_LOCAL_AI_BASE_URL || "").replace(/\/+$/, ""),
    directVisionUrl: (process.env.MEDIBLIX_LOCAL_AI_VISION_BASE_URL || "").replace(/\/+$/, ""),
    modelDir: modelManager.getModelDir(),
    textModel: catalog?.models?.text?.id || "text",
    visionModel: catalog?.models?.vision?.id || "vision",
    runtime: catalog?.runtime?.name || "llama.cpp",
    tier: tierId,
    textFamily: tierModels?.text?.family || "",
    visionCapability: tierModels?.vision?.capability || "vision",
    scan,
    healthTimeoutMs: Number(process.env.MEDIBLIX_LOCAL_AI_HEALTH_TIMEOUT_MS || 2500),
    textTimeoutMs: Number(process.env.MEDIBLIX_LOCAL_TEXT_TIMEOUT_MS || DEFAULT_TEXT_TIMEOUT_MS),
    visionTimeoutMs: Number(process.env.MEDIBLIX_LOCAL_VISION_TIMEOUT_MS || DEFAULT_VISION_TIMEOUT_MS),
    disabled: String(process.env.MEDIBLIX_LOCAL_AI || "").toLowerCase() === "off",
  };
}

function emptyHealth() {
  const cfg = getConfig();
  return {
    available: false,
    backend: cfg.runtime,
    url: cfg.directTextUrl || null,
    version: null,
    models: [],
    textModel: cfg.textModel,
    visionModel: cfg.visionModel,
    textModelReady: false,
    visionModelReady: false,
    runtimeInstalled: false,
    modelDir: cfg.modelDir,
    servers: { text: { running: false, baseUrl: null }, vision: { running: false, baseUrl: null } },
    setupRequired: false,
    missing: [],
    disabled: cfg.disabled,
    error: null,
    networkCode: null,
    inferenceProbe: null,
  };
}

async function controlRequest(path, { method = "GET", body, timeoutMs = 4000 } = {}) {
  const cfg = getConfig();
  if (!cfg.controlUrl) {
    throw new AIError(
      AI_ERROR.LOCAL_UNAVAILABLE,
      "The local AI runtime is not managed by the Mediblix application in this session.",
      { provider: "local", details: { reason: "no-control-channel" } }
    );
  }

  let response;
  try {
    response = await fetch(`${cfg.controlUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.controlToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new AIError(AI_ERROR.LOCAL_UNAVAILABLE, "The local AI runtime could not be reached from the Mediblix backend.", {
      provider: "local",
      cause: error,
    });
  }

  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

/**
 * Availability of offline AI. Never throws; availability is data.
 *
 * `available` means "offline AI can serve this request", i.e. the bundled
 * runtime is present AND the needed model files are installed. It does not
 * mean a model process is already resident — those start on demand.
 */
export async function checkHealth({ force = false } = {}) {
  const cfg = getConfig();
  const now = Date.now();

  if (!force && healthCache.value && now - healthCache.at < HEALTH_CACHE_MS) {
    return healthCache.value;
  }

  const result = emptyHealth();

  if (cfg.disabled) {
    result.error = "Offline AI is turned off in the Mediblix settings (MEDIBLIX_LOCAL_AI=off).";
    healthCache = { at: now, value: result };
    return result;
  }

  // Direct mode: a slot URL was supplied explicitly (development / tests).
  if (cfg.directTextUrl) {
    result.url = cfg.directTextUrl;
    try {
      const res = await fetch(`${cfg.directTextUrl}/health`, {
        signal: AbortSignal.timeout(cfg.healthTimeoutMs),
      });
      // llama-server answers 503 while it is loading a model.
      if (res.ok) {
        result.available = true;
        result.runtimeInstalled = true;
        result.textModelReady = true;
        // A single direct server (development/tests) serves both slots.
        result.visionModelReady = Boolean(cfg.directVisionUrl || cfg.directTextUrl);
        result.models = [cfg.textModel];
        result.servers.text = { running: true, baseUrl: cfg.directTextUrl };
        result.servers.vision = { running: Boolean(cfg.directVisionUrl), baseUrl: cfg.directVisionUrl || null };
      } else {
        result.error = `The local AI runtime is starting (HTTP ${res.status}).`;
      }
    } catch (error) {
      result.error = `The local AI runtime is not reachable at ${cfg.directTextUrl}.`;
      result.networkCode = error?.cause?.code || error?.code || null;
    }

    healthCache = { at: now, value: result };
    return result;
  }

  // Managed mode: ask the Electron supervisor.
  try {
    const { ok, payload } = await controlRequest("/status");
    if (!ok || !payload) {
      result.error = "The local AI supervisor did not answer.";
      healthCache = { at: now, value: result };
      return result;
    }

    const textInstalled = Boolean(payload.models?.text?.installed);
    const visionInstalled = Boolean(payload.models?.vision?.installed);
    const runtimeInstalled = Boolean(payload.runtime?.installed);

    result.runtimeInstalled = runtimeInstalled;
    result.modelDir = payload.modelDir || result.modelDir;
    result.setupRequired = Boolean(payload.setupRequired);
    result.textModelReady = runtimeInstalled && textInstalled;
    result.visionModelReady = runtimeInstalled && visionInstalled;
    result.available = result.textModelReady || result.visionModelReady;
    result.installedModels = [textInstalled ? cfg.textModel : null, visionInstalled ? cfg.visionModel : null].filter(Boolean);
    result.models = result.installedModels;
    result.servers = payload.servers || result.servers;
    result.missing = [
      ...(payload.models?.text?.missing || []).map((m) => ({ kind: "text", ...m })),
      ...(payload.models?.vision?.missing || []).map((m) => ({ kind: "vision", ...m })),
    ];

    if (!runtimeInstalled) {
      result.error = "The bundled local AI runtime is missing from this installation.";
    } else if (!result.available) {
      result.error = "Offline AI models are not installed yet.";
    }
  } catch (error) {
    result.error = error?.message || "The local AI runtime is unavailable.";
  }

  healthCache = { at: now, value: result };
  return result;
}

export function resetHealthCache() {
  healthCache = { at: 0, value: null };
  probeCache = { at: 0, value: null };
}

function describeMissing(kind, health) {
  const model = kind === "vision" ? health.visionModel : health.textModel;
  const names = (health.missing || [])
    .filter((m) => m.kind === kind)
    .map((m) => m.name)
    .filter(Boolean);
  const suffix = names.length ? ` (missing: ${names.join(", ")})` : "";
  return `The offline ${kind} model "${model}" is not installed${suffix}.`;
}

/**
 * Ensures the requested model slot is running, and returns its base URL.
 * In direct mode the caller supplied the server, so there is nothing to start.
 */
export async function ensureModelReady(kind = "text") {
  const cfg = getConfig();
  const health = await checkHealth();

  if (cfg.disabled) {
    throw new AIError(AI_ERROR.LOCAL_DISABLED, "Offline AI is turned off.", { provider: "local" });
  }

  if (cfg.directTextUrl) {
    if (!health.available) {
      throw new AIError(
        AI_ERROR.LOCAL_UNAVAILABLE,
        health.error || "The local AI runtime is not reachable.",
        { provider: "local" }
      );
    }
    return {
      baseUrl: kind === "vision" ? cfg.directVisionUrl || cfg.directTextUrl : cfg.directTextUrl,
      model: kind === "vision" ? cfg.visionModel : cfg.textModel,
    };
  }

  const ready = kind === "vision" ? health.visionModelReady : health.textModelReady;
  if (!health.runtimeInstalled) {
    throw new AIError(
      AI_ERROR.LOCAL_UNAVAILABLE,
      "The bundled local AI runtime is missing from this installation. Reinstall Mediblix to restore offline AI.",
      { provider: "local" }
    );
  }
  if (!ready) {
    throw new AIError(AI_ERROR.LOCAL_MODEL_MISSING, describeMissing(kind, health), {
      provider: "local",
      details: { kind, missing: health.missing || [] },
    });
  }

  const { ok, payload } = await controlRequest("/ensure", {
    method: "POST",
    body: { kind },
    // Starting a slot can include loading a multi-GB model into memory.
    timeoutMs: 120000,
  });

  if (!ok || !payload?.ok) {
    const reason = payload?.reason || "start-failed";
    const message =
      payload?.message ||
      (reason === "model-not-installed"
        ? describeMissing(kind, health)
        : reason === "runtime-not-installed"
          ? "The bundled local AI runtime is missing from this installation."
          : reason === "crash-loop"
            ? "The local AI runtime keeps stopping. Restart Mediblix to try again."
            : "The offline AI model could not be started.");

    const code =
      reason === "model-not-installed"
        ? AI_ERROR.LOCAL_MODEL_MISSING
        : reason === "disabled"
          ? AI_ERROR.LOCAL_DISABLED
          : AI_ERROR.LOCAL_UNAVAILABLE;

    throw new AIError(code, message, { provider: "local", details: { kind, reason } });
  }

  return { baseUrl: payload.baseUrl, model: payload.model };
}

export async function unloadModel(kind = "vision") {
  const cfg = getConfig();
  if (!cfg.controlUrl) return { unloaded: false, reason: "not-managed" };
  try {
    const { payload } = await controlRequest("/unload", { method: "POST", body: { kind } });
    return payload || { unloaded: false };
  } catch {
    return { unloaded: false, reason: "control-unavailable" };
  }
}

function extractContent(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }
  return "";
}

function mapServerError(status, message, kind) {
  const text = String(message || "");

  if (status === 503) {
    return new AIError(
      AI_ERROR.LOCAL_UNAVAILABLE,
      "The offline AI model is still loading. Try again in a few seconds.",
      { provider: "local", retryable: true, details: { raw: text.slice(0, 200) } }
    );
  }
  if (/context (length|size)|too many tokens|exceeds/i.test(text)) {
    return new AIError(
      AI_ERROR.INPUT_TOO_LARGE,
      "This document is too long for the offline model. Try uploading fewer pages at a time.",
      { provider: "local", details: { raw: text.slice(0, 200) } }
    );
  }
  if (status === 404 || /model.*not found|failed to load model/i.test(text)) {
    return new AIError(AI_ERROR.LOCAL_MODEL_MISSING, `The offline ${kind} model could not be loaded.`, {
      provider: "local",
      details: { raw: text.slice(0, 200) },
    });
  }
  if (/out of memory|insufficient memory|failed to allocate|ggml_backend/i.test(text)) {
    return new AIError(
      AI_ERROR.LOCAL_UNAVAILABLE,
      "The offline model could not be loaded — this computer does not have enough free memory. Close other applications and try again.",
      { provider: "local", details: { raw: text.slice(0, 200) } }
    );
  }

  return new AIError(AI_ERROR.LOCAL_UNAVAILABLE, text || `The offline AI runtime returned HTTP ${status}.`, {
    provider: "local",
    details: { status },
  });
}

async function chatCompletion({ baseUrl, model, messages, numPredict, timeoutMs, jsonMode, kind }) {
  const body = {
    model,
    messages,
    stream: false,
    temperature: 0,
    top_p: 0.9,
    max_tokens: numPredict,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const send = async (payload) => {
    let response;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        const seconds = Math.max(1, Math.round(timeoutMs / 1000));
        throw new AIError(
          AI_ERROR.TIMEOUT,
          `The offline AI model did not finish within ${seconds} second${seconds === 1 ? "" : "s"}. Try a smaller document, or a shorter question.`,
          { provider: "local", retryable: true, cause: error }
        );
      }
      throw new AIError(
        AI_ERROR.LOCAL_UNAVAILABLE,
        "The offline AI runtime stopped responding. It will be restarted on the next request.",
        { provider: "local", retryable: true, cause: error }
      );
    }

    const text = await response.text();
    let payloadJson = null;
    try {
      payloadJson = text ? JSON.parse(text) : null;
    } catch {
      payloadJson = null;
    }

    return { response, payloadJson, rawText: text };
  };

  let attempt = await send(body);

  // Some builds/templates reject response_format. Retry once without it rather
  // than failing a document the model could otherwise parse.
  if (!attempt.response.ok && jsonMode && attempt.response.status === 400) {
    delete body.response_format;
    attempt = await send(body);
  }

  if (!attempt.response.ok) {
    throw mapServerError(
      attempt.response.status,
      attempt.payloadJson?.error?.message || attempt.payloadJson?.error || attempt.rawText,
      kind
    );
  }

  return attempt.payloadJson;
}

/**
 * How scanned pages are read offline (see modelManager.getScanPipeline).
 */
export function getScanPipeline() {
  return getConfig().scan;
}

/**
 * "ocr" when the installed second model reads pages to text instead of
 * answering a prompt about them.
 */
export function getVisionCapability() {
  return getConfig().visionCapability;
}

function normaliseOcrText(text) {
  const stripped = String(text || "")
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/```\s*$/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped.slice(0, 60000);
}

// A page with real invoice content easily clears this; a hallucinated or empty
// page does not.
const OCR_MIN_CHARS = 24;
const OCR_MIN_ALNUM_RATIO = 0.25;
const OCR_REPEAT_RUN = 8;

/**
 * Judges whether an OCR result is usable.
 *
 * llama.cpp OCR has two realistic failure modes: an empty/blank page and a
 * runaway repetition loop. Both are detectable, and both must become a visible
 * failure rather than silently missing line items on an invoice.
 */
export function assessOcrText(text) {
  const value = normaliseOcrText(text);
  if (!value) return { ok: false, reason: "empty", text: "" };
  if (value.length < OCR_MIN_CHARS) return { ok: false, reason: "too-short", text: value };

  const alnum = value.replace(/[^A-Za-z0-9]/g, "").length;
  if (alnum / value.length < OCR_MIN_ALNUM_RATIO) {
    return { ok: false, reason: "no-readable-text", text: value };
  }

  const lines = value.split("\n").map((line) => line.trim());
  let run = 1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] && lines[index] === lines[index - 1]) {
      run += 1;
      if (run >= OCR_REPEAT_RUN) return { ok: false, reason: "repetition-loop", text: value };
    } else {
      run = 1;
    }
  }

  return { ok: true, reason: null, text: value };
}

/**
 * Reads page images with the bundled document-OCR model and returns plain text.
 *
 * Pages are sent one at a time so one bad page (a known llama.cpp OCR failure
 * mode is a runaway repetition loop) cannot destroy the whole invoice. A page
 * that produces nothing after its retries is skipped and reported.
 *
 * The caller is responsible for unloading the vision slot afterwards: the text
 * model must never load while this model is still resident.
 */
export async function ocrImages(images, { prompt, maxTokens, timeoutMs } = {}) {
  const cfg = getConfig();
  const pages = (images || []).slice(0, cfg.scan.maxPages || 5);
  if (pages.length === 0) {
    throw new AIError(AI_ERROR.INPUT_REQUIRED, "No page images were provided for offline reading.", {
      provider: "local",
    });
  }

  const { baseUrl, model } = await ensureModelReady("vision");
  const startedAt = Date.now();
  const parts = [];
  const failures = [];

  for (let index = 0; index < pages.length; index += 1) {
    const image = pages[index];
    const attempts = 1 + Math.max(0, Number(cfg.scan.pageRetries) || 0);
    let pageText = "";
    let lastError = null;

    for (let attempt = 0; attempt < attempts && !pageText; attempt += 1) {
      try {
        const payload = await chatCompletion({
          baseUrl,
          model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: image.startsWith("data:") ? image : `data:image/png;base64,${image}` },
                },
                { type: "text", text: prompt || cfg.scan.prompt || "OCR:" },
              ],
            },
          ],
          numPredict: maxTokens || cfg.scan.maxTokens,
          timeoutMs: timeoutMs || cfg.visionTimeoutMs,
          jsonMode: false,
          kind: "vision",
        });
        const assessment = assessOcrText(extractContent(payload));
        if (assessment.ok) {
          pageText = assessment.text;
        } else {
          lastError = { code: `ocr-${assessment.reason}` };
        }
      } catch (error) {
        lastError = toAIError(error);
      }
    }

    if (pageText) parts.push(pageText);
    else failures.push({ page: index + 1, reason: lastError?.reason || lastError?.code || "empty-output" });
  }

  const text = parts.join("\n\n").trim();

  // Never drop a page quietly: on an invoice every page can carry medicines.
  if (failures.length > 0) {
    const readPages = parts.length;
    throw new AIError(
      AI_ERROR.INVALID_OUTPUT,
      `The offline OCR model could not read ${failures.length} of ${pages.length} page(s) (page ${failures
        .map((failure) => failure.page)
        .join(", ")}). No items were returned, because a partially read invoice would be misleading. Try a sharper, straighter photo or a digital PDF.`,
      { provider: "local", details: { failures, readPages, pages: pages.length } }
    );
  }

  if (!text) {
    throw new AIError(
      AI_ERROR.EMPTY_OUTPUT,
      "The offline model could not read any text from this document. Try a clearer scan or a digital PDF.",
      { provider: "local", details: { failures } }
    );
  }

  return {
    text,
    model,
    provider: "local",
    durationMs: Date.now() - startedAt,
    pages: pages.length,
    readPages: parts.length,
    failures,
  };
}

/**
 * JSON-mode chat completion. The caller validates the parsed shape.
 */
export async function chatJSON({
  system,
  prompt,
  images = null,
  numPredict = 900,
  timeoutMs,
  kind = null,
} = {}) {
  const cfg = getConfig();
  const slot = kind || (images && images.length > 0 ? "vision" : "text");

  const { baseUrl, model } = await ensureModelReady(slot);

  // Qwen3 models "think" by default, which wastes the token budget and breaks
  // strict JSON output. `/no_think` is the template's documented switch.
  const systemPrompt = /qwen3/i.test(cfg.textFamily)
    ? `${system ? `${system}\n\n` : ""}/no_think`
    : system;

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });

  if (images && images.length > 0) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...images.slice(0, 10).map((image) => ({
          type: "image_url",
          image_url: { url: image.startsWith("data:") ? image : `data:image/png;base64,${image}` },
        })),
      ],
    });
  } else {
    messages.push({ role: "user", content: prompt });
  }

  const startedAt = Date.now();
  const payload = await chatCompletion({
    baseUrl,
    model,
    messages,
    numPredict,
    timeoutMs: timeoutMs || (slot === "vision" ? cfg.visionTimeoutMs : cfg.textTimeoutMs),
    jsonMode: true,
    kind: slot,
  });

  const text = extractContent(payload);
  if (!text) {
    throw new AIError(AI_ERROR.EMPTY_OUTPUT, "The offline AI model returned an empty response.", {
      provider: "local",
    });
  }

  return {
    data: parseLooseJSON(text),
    text,
    model,
    durationMs: Date.now() - startedAt,
    provider: "local",
    mode: slot,
  };
}

/**
 * Plain-text completion (intent classification, short answers).
 */
export async function chatText({ system, prompt, numPredict = 200, timeoutMs } = {}) {
  const cfg = getConfig();
  const { baseUrl, model } = await ensureModelReady("text");

  const systemPrompt = /qwen3/i.test(cfg.textFamily)
    ? `${system ? `${system}\n\n` : ""}/no_think`
    : system;

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const payload = await chatCompletion({
    baseUrl,
    model,
    messages,
    numPredict,
    timeoutMs: timeoutMs || cfg.textTimeoutMs,
    jsonMode: false,
    kind: "text",
  });

  const text = extractContent(payload);
  if (!text) {
    throw new AIError(AI_ERROR.EMPTY_OUTPUT, "The offline AI model returned an empty response.", {
      provider: "local",
    });
  }

  return { text, model, provider: "local" };
}

/**
 * Proves inference works (not merely that a port answers). Loads the text
 * model, so it is opt-in and cached for a minute.
 */
export async function probeInference({ force = false, timeoutMs = 90000 } = {}) {
  const now = Date.now();
  if (!force && probeCache.value && now - probeCache.at < PROBE_CACHE_MS) {
    return probeCache.value;
  }

  const cfg = getConfig();
  const result = { ok: false, model: cfg.textModel, durationMs: null, error: null };

  try {
    const startedAt = Date.now();
    const { baseUrl, model } = await ensureModelReady("text");
    await chatCompletion({
      baseUrl,
      model,
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
      numPredict: 8,
      timeoutMs,
      jsonMode: false,
      kind: "text",
    });
    result.ok = true;
    result.durationMs = Date.now() - startedAt;
  } catch (error) {
    const aiError = toAIError(error);
    result.error = { code: aiError.code, message: aiError.message };
  }

  probeCache = { at: Date.now(), value: result };
  return result;
}

/**
 * Downloads a local model (kind = "text" | "vision") into application data.
 */
export async function installModel(kind, onProgress) {
  const result = await modelManager.installModel(kind, onProgress);
  resetHealthCache();
  return result;
}

export function getModelsStatus() {
  return modelManager.listModels();
}

export function getSetupSummary() {
  return modelManager.getSetupSummary();
}

export function verifyModel(kind, options) {
  return modelManager.verifyModel(kind, options);
}

export default {
  getConfig,
  checkHealth,
  resetHealthCache,
  ensureModelReady,
  getScanPipeline,
  getVisionCapability,
  ocrImages,
  chatJSON,
  chatText,
  probeInference,
  unloadModel,
  installModel,
  getModelsStatus,
  getSetupSummary,
  verifyModel,
};
