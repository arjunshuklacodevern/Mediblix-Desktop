/**
 * Mediblix Desktop — Local model manager
 *
 * Owns the GGUF files that make offline AI work. Nothing here touches SQLite,
 * and no model file ever ships inside the installer for the default strategy:
 * models are downloaded once into the user's application-data directory, where
 * application updates cannot delete them.
 *
 * Guarantees:
 *  - Downloads are resumable (.part file + HTTP Range) and verified by SHA-256.
 *  - A file only becomes "the model" after its digest matches the catalog.
 *  - Only catalog entries can be downloaded (no arbitrary URLs or names).
 *  - Everything works without any network dependency at inference time.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { AI_ERROR, AIError } from "./aiErrors.js";
import aiCatalog from "../../electron/ai-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHA_CHECK_TTL_MS = 10 * 60 * 1000;
const verifyCache = new Map();

function platformDefaultModelDir() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Mediblix", "ai-models");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Mediblix", "ai-models");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "mediblix", "ai-models");
}

function catalogPath() {
  return process.env.MEDIBLIX_MODEL_CATALOG || path.join(__dirname, "..", "..", "electron", "ai-model-catalog.json");
}

let cachedCatalog = null;
let cachedCatalogPath = null;

export function getCatalog() {
  const target = catalogPath();
  if (cachedCatalog && cachedCatalogPath === target) return cachedCatalog;

  try {
    cachedCatalog = JSON.parse(fs.readFileSync(target, "utf8"));
    cachedCatalogPath = target;
    return cachedCatalog;
  } catch (error) {
    throw new AIError(
      AI_ERROR.LOCAL_UNAVAILABLE,
      "The local AI model catalog is missing from this installation.",
      { provider: "local", cause: error, details: { path: target } }
    );
  }
}

export function getModelDir() {
  return process.env.MEDIBLIX_MODEL_DIR || platformDefaultModelDir();
}

/**
 * The tier this installation should use. Electron detects the hardware and
 * passes the decision in MEDIBLIX_AI_TIER; the catalog's default is the
 * fallback when the backend runs on its own (tests, development).
 */
export function getActiveTier() {
  const catalog = getCatalog();
  const resolved = aiCatalog.resolveTier(catalog, process.env.MEDIBLIX_AI_TIER || null);
  return {
    id: resolved.id,
    label: resolved.label,
    requirements: resolved.tier?.requirements || null,
    requested: resolved.requestedTier,
    downgraded: resolved.fallback,
  };
}

/** Hardware snapshot reported by Electron. Never trusted for security, only for UI copy. */
export function getHardwareSnapshot() {
  const raw = process.env.MEDIBLIX_AI_HARDWARE;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function getModelSpec(kind) {
  const catalog = getCatalog();
  const resolved = aiCatalog.resolveTier(catalog, process.env.MEDIBLIX_AI_TIER || null);
  const spec = resolved.models[kind];
  if (!spec) {
    throw new AIError(AI_ERROR.LOCAL_DISABLED, `Unknown local model kind "${kind}".`, {
      provider: "local",
    });
  }
  return spec;
}

export function getRuntimeSpec() {
  return getCatalog().runtime || {};
}

/**
 * How scanned pages are read offline. OCR-to-text is implemented but ships
 * disabled until accuracy on real invoices is signed off.
 */
export function getScanPipeline() {
  const pipeline = getCatalog().pipelines?.scan || {};
  const override = String(process.env.MEDIBLIX_SCAN_OCR || "").toLowerCase();
  const enabled = override === "on" || override === "1" ? true : override === "off" || override === "0" ? false : Boolean(pipeline.productionApproved);

  return {
    mode: enabled ? "ocr" : "direct",
    configuredMode: pipeline.mode || "ocr",
    ocrEnabled: enabled,
    experimental: !pipeline.productionApproved,
    prompt: pipeline.ocr?.prompt || "OCR:",
    maxTokens: Number(pipeline.ocr?.maxTokens) || 2048,
    pageRetries: Number(pipeline.ocr?.pageRetries) || 1,
    maxPages: Number(pipeline.ocr?.maxPages) || 5,
    note: pipeline.note || null,
  };
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/**
 * Presence + size report for one model kind. Cheap: no hashing.
 */
export function inspectModel(kind) {
  const spec = getModelSpec(kind);
  const dir = getModelDir();
  const files = [];
  const missing = [];
  let bytes = 0;

  for (const file of spec.files || []) {
    const fullPath = path.join(dir, file.name);
    const stat = statOrNull(fullPath);
    const ok = Boolean(stat) && (!file.bytes || stat.size === file.bytes);
    if (ok) bytes += stat.size;
    else if (stat && file.bytes) {
      missing.push({ name: file.name, reason: `incomplete (${stat.size} of ${file.bytes} bytes)` });
    } else {
      missing.push({ name: file.name, reason: "missing" });
    }
    files.push({ name: file.name, role: file.role || "model", path: fullPath, ok, bytes: stat?.size ?? null });
  }

  return {
    kind,
    id: spec.id,
    displayName: spec.displayName,
    installed: missing.length === 0,
    dir,
    files,
    missing,
    bytes,
    totalBytes: (spec.files || []).reduce((sum, f) => sum + (f.bytes || 0), 0),
  };
}

export function listModels() {
  const resolved = aiCatalog.resolveTier(getCatalog(), process.env.MEDIBLIX_AI_TIER || null);
  const result = {};
  for (const kind of Object.keys(resolved.models || {})) {
    result[kind] = inspectModel(kind);
  }
  return result;
}

function sha256File(target) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Full integrity verification of installed model files.
 */
export async function verifyModel(kind, { force = false } = {}) {
  const spec = getModelSpec(kind);
  const cached = verifyCache.get(kind);
  if (!force && cached && Date.now() - cached.at < SHA_CHECK_TTL_MS) return cached.value;

  const results = [];
  let ok = true;

  for (const file of spec.files || []) {
    const fullPath = path.join(getModelDir(), file.name);
    if (!statOrNull(fullPath)) {
      results.push({ name: file.name, ok: false, reason: "missing" });
      ok = false;
      continue;
    }
    try {
      const digest = await sha256File(fullPath);
      const matches = !file.sha256 || digest === file.sha256;
      results.push({ name: file.name, ok: matches, reason: matches ? null : "checksum mismatch" });
      if (!matches) ok = false;
    } catch (error) {
      results.push({ name: file.name, ok: false, reason: error.message });
      ok = false;
    }
  }

  const value = { kind, ok, files: results, verifiedAt: new Date().toISOString() };
  verifyCache.set(kind, { at: Date.now(), value });
  return value;
}

async function downloadFile(file, { onProgress, signal } = {}) {
  const dir = getModelDir();
  await fsp.mkdir(dir, { recursive: true });

  const finalPath = path.join(dir, file.name);
  const partPath = `${finalPath}.part`;

  let start = 0;
  const existing = statOrNull(partPath);
  if (existing) start = existing.size;

  // Already complete by size? Verify by digest and stop early.
  const current = statOrNull(finalPath);
  if (current && (!file.bytes || current.size === file.bytes)) {
    return { name: file.name, path: finalPath, skipped: true };
  }

  let response;
  try {
    response = await fetch(file.url, {
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
      signal: signal || undefined,
      redirect: "follow",
    });
  } catch (error) {
    throw new AIError(AI_ERROR.LOCAL_UNAVAILABLE, "The model download could not be started. Check your internet connection.", {
      provider: "local",
      retryable: true,
      cause: error,
      details: { file: file.name },
    });
  }

  if (response.status === 416) {
    // Range unsatisfiable: the .part is already the whole file.
    start = 0;
    await fsp.rm(partPath, { force: true });
    return downloadFile(file, { onProgress, signal });
  }

  if (!response.ok) {
    throw new AIError(AI_ERROR.LOCAL_UNAVAILABLE, `The model download failed (HTTP ${response.status}).`, {
      provider: "local",
      details: { file: file.name, status: response.status },
    });
  }

  const resuming = response.status === 206;
  if (!resuming && start > 0) start = 0;

  const contentLength = Number(response.headers.get("content-length") || 0);
  const total = file.bytes || (resuming ? start + contentLength : contentLength) || null;

  const handle = await fsp.open(partPath, resuming ? "a" : "w");
  let written = start;
  let lastReport = 0;

  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      written += value.byteLength;
      if (onProgress && Date.now() - lastReport > 400) {
        lastReport = Date.now();
        onProgress({
          file: file.name,
          completed: written,
          total,
          percent: total ? Math.min(100, Math.round((written / total) * 100)) : null,
        });
      }
    }
  } catch (error) {
    throw new AIError(AI_ERROR.TIMEOUT, "The model download was interrupted. It will resume where it stopped.", {
      provider: "local",
      retryable: true,
      cause: error,
    });
  } finally {
    await handle.close();
  }

  onProgress?.({ file: file.name, completed: written, total, percent: 100 });

  // Verify before the file becomes visible as the model.
  if (file.sha256) {
    const digest = await sha256File(partPath);
    if (digest !== file.sha256) {
      await fsp.rm(partPath, { force: true });
      throw new AIError(
        AI_ERROR.LOCAL_UNAVAILABLE,
        `The downloaded ${file.name} is corrupted (checksum mismatch) and was discarded. Please try again.`,
        { provider: "local", details: { file: file.name } }
      );
    }
  }

  await fsp.rename(partPath, finalPath);
  return { name: file.name, path: finalPath, bytes: written };
}

/**
 * Downloads every file of a model kind. Safe to call again after a failure:
 * completed files are skipped and partial files resume.
 */
export async function installModel(kind, onProgress) {
  const spec = getModelSpec(kind);
  const files = spec.files || [];
  const totalBytes = files.reduce((sum, f) => sum + (f.bytes || 0), 0);

  onProgress?.({ phase: "starting", kind, model: spec.displayName, total: totalBytes });

  const installed = [];
  let completedBytes = 0;

  for (const file of files) {
    const result = await downloadFile(file, {
      onProgress: (progress) => {
        onProgress?.({
          phase: "downloading",
          kind,
          model: spec.displayName,
          file: progress.file,
          completed: completedBytes + (progress.completed || 0),
          total: totalBytes,
          percent: totalBytes ? Math.min(100, Math.round(((completedBytes + (progress.completed || 0)) / totalBytes) * 100)) : null,
        });
      },
    });
    installed.push(result.name);
    completedBytes += file.bytes || statOrNull(result.path)?.size || 0;
  }

  verifyCache.delete(kind);
  const status = inspectModel(kind);

  if (!status.installed) {
    throw new AIError(AI_ERROR.LOCAL_MODEL_MISSING, `The ${kind} model finished downloading but its files are incomplete.`, {
      provider: "local",
      details: { missing: status.missing },
    });
  }

  onProgress?.({ phase: "done", kind, model: spec.displayName, percent: 100, installed });
  return { kind, installed, bytes: status.bytes };
}

/**
 * Total download size for both models, for setup UI.
 */
export function getSetupSummary() {
  const catalog = getCatalog();
  const resolved = aiCatalog.resolveTier(catalog, process.env.MEDIBLIX_AI_TIER || null);
  const models = listModels();
  const requiredKinds = Object.keys(resolved.models || {});
  const pending = requiredKinds.filter((kind) => !models[kind].installed);
  const downloadBytes = pending.reduce((sum, kind) => sum + (models[kind].totalBytes || 0), 0);

  return {
    modelDir: getModelDir(),
    runtime: catalog.runtime?.name || "llama.cpp",
    runtimeBuild: catalog.runtime?.pinnedBuild || null,
    tier: {
      id: resolved.id,
      label: resolved.label,
      requiredKinds,
      totalBytes: aiCatalog.totalBytes(resolved),
    },
    hardware: getHardwareSnapshot(),
    scan: getScanPipeline(),
    models,
    pendingKinds: pending,
    downloadBytes,
    setupRequired: pending.length > 0,
  };
}

export default {
  getCatalog,
  getModelDir,
  getActiveTier,
  getHardwareSnapshot,
  getModelSpec,
  getRuntimeSpec,
  getScanPipeline,
  inspectModel,
  listModels,
  verifyModel,
  installModel,
  getSetupSummary,
};
