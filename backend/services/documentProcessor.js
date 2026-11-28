/**
 * Mediblix Desktop — Document processor
 *
 * Turns the base64 payloads the frontend already sends into something a model
 * can read, for both providers:
 *
 *   digital PDF  ──► embedded text  ──► text model  (fast, exact)
 *   scanned PDF  ──► page screenshots ──► vision model
 *   JPG/PNG      ──► image ──────────► vision model
 *   audio        ──► online only (no local transcription model is bundled)
 *
 * Nothing here writes to SQLite; it only prepares and normalises input.
 */

import { AI_ERROR, AIError } from "./aiErrors.js";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PDF_PAGES = 5;
const MAX_VISION_IMAGES = 10;
const MAX_TEXT_CHARS = 60000;
// A page of real invoice text easily clears this; a scan yields almost nothing.
const MIN_USABLE_TEXT_CHARS = 120;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/bmp", "image/tiff"]);
const AUDIO_MIMES = new Set([
  "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/flac",
]);

function stripDataUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const commaIndex = trimmed.indexOf(",");
  if (trimmed.startsWith("data:") && commaIndex !== -1) {
    return trimmed.slice(commaIndex + 1);
  }
  return trimmed;
}

function normalizeMime(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function sniffKind(buffer, declaredMime) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { kind: "pdf", mimeType: "application/pdf" };
  }
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { kind: "image", mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { kind: "image", mimeType: "image/webp" };
  }

  if (declaredMime === "application/pdf") return { kind: "pdf", mimeType: declaredMime };
  if (IMAGE_MIMES.has(declaredMime)) return { kind: "image", mimeType: declaredMime };
  if (AUDIO_MIMES.has(declaredMime)) return { kind: "audio", mimeType: declaredMime };

  return { kind: "other", mimeType: declaredMime || "application/octet-stream" };
}

/**
 * Normalises the two accepted request shapes:
 *   { fileData, mimeType }  |  { files: [{ fileData, mimeType }] }
 */
export function normalizeInputs(body = {}) {
  const rawEntries = [];

  if (Array.isArray(body.files) && body.files.length > 0) {
    for (const file of body.files) {
      if (file && file.fileData) rawEntries.push(file);
    }
  } else if (body.fileData) {
    rawEntries.push({ fileData: body.fileData, mimeType: body.mimeType });
  }

  if (rawEntries.length === 0) {
    throw new AIError(AI_ERROR.INPUT_REQUIRED, "File data or files array is required.");
  }

  if (rawEntries.length > MAX_FILES) {
    throw new AIError(
      AI_ERROR.INPUT_TOO_LARGE,
      `A maximum of ${MAX_FILES} files can be analysed at once (received ${rawEntries.length}).`
    );
  }

  let totalBytes = 0;

  const inputs = rawEntries.map((entry, index) => {
    const base64 = stripDataUrl(entry.fileData);
    if (!base64) {
      throw new AIError(AI_ERROR.INPUT_INVALID, `File ${index + 1} contains no data.`);
    }

    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) {
      throw new AIError(AI_ERROR.INPUT_INVALID, `File ${index + 1} could not be decoded.`);
    }
    if (buffer.length > MAX_FILE_BYTES) {
      throw new AIError(
        AI_ERROR.INPUT_TOO_LARGE,
        `File ${index + 1} is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB per file.`
      );
    }

    totalBytes += buffer.length;
    const declaredMime = normalizeMime(entry.mimeType);
    const { kind, mimeType } = sniffKind(buffer, declaredMime);

    if (kind === "other") {
      throw new AIError(
        AI_ERROR.INPUT_UNSUPPORTED,
        `File ${index + 1} is not a supported type (${declaredMime || "unknown"}). Upload a PDF, JPG or PNG.`
      );
    }

    return {
      index,
      kind,
      mimeType,
      base64,
      buffer,
      byteLength: buffer.length,
      fileName: entry.fileName || null,
    };
  });

  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new AIError(
      AI_ERROR.INPUT_TOO_LARGE,
      `The selected files total ${(totalBytes / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_TOTAL_BYTES / 1024 / 1024} MB per request.`
    );
  }

  return inputs;
}

// ─────────────────────────────────────────────────
// PDF handling
// ─────────────────────────────────────────────────

async function loadPdfParse() {
  try {
    return await import("pdf-parse");
  } catch (error) {
    throw new AIError(
      AI_ERROR.PDF_SUPPORT_MISSING,
      "Offline PDF reading requires the 'pdf-parse' package, which is not installed on this machine.",
      { details: { package: "pdf-parse" }, cause: error }
    );
  }
}

export function hasUsableText(text) {
  if (!text) return false;
  const stripped = String(text).replace(/\s+/g, " ").trim();
  if (stripped.length < MIN_USABLE_TEXT_CHARS) return false;
  const alphanumeric = stripped.replace(/[^A-Za-z0-9]/g, "").length;
  return alphanumeric >= MIN_USABLE_TEXT_CHARS;
}

/**
 * Extracts the embedded text layer from a PDF.
 */
export async function extractPdfText(buffer) {
  const { PDFParse } = await loadPdfParse();
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    const info = await parser.getInfo().catch(() => null);
    const textResult = await parser.getText();
    const text = String(textResult?.text || "")
      .replace(/--\s*\d+\s+of\s+\d+\s*--/g, "")
      .trim();

    return {
      text,
      pageCount: info?.total ?? textResult?.total ?? null,
      hasUsableText: hasUsableText(text),
    };
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError(
      AI_ERROR.INPUT_INVALID,
      "This PDF could not be read. It may be password-protected or corrupted.",
      { cause: error }
    );
  } finally {
    try {
      await parser.destroy();
    } catch {
      // Ignore teardown failures; the parse result is already captured.
    }
  }
}

/**
 * Renders PDF pages to PNG for the vision model (used for scans and photos
 * saved as PDF).
 */
export async function renderPdfPages(buffer, { maxPages = DEFAULT_MAX_PDF_PAGES, desiredWidth = 1600 } = {}) {
  const { PDFParse } = await loadPdfParse();
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    let shot;
    try {
      shot = await parser.getScreenshot({ first: 1, last: maxPages, desiredWidth });
    } catch {
      // Older/newer pdf-parse builds may not accept `last`.
      shot = await parser.getScreenshot({ first: 1, desiredWidth });
    }

    const pages = (shot?.pages || []).slice(0, maxPages);
    return pages.map((page) => ({
      mimeType: "image/png",
      base64: Buffer.from(page.data).toString("base64"),
      pageNumber: page.pageNumber ?? null,
      width: page.width ?? null,
      height: page.height ?? null,
    }));
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError(AI_ERROR.INPUT_INVALID, "This PDF's pages could not be rendered for analysis.", {
      cause: error,
    });
  } finally {
    try {
      await parser.destroy();
    } catch {
      // Ignore teardown failures.
    }
  }
}

// ─────────────────────────────────────────────────
// Provider-specific preparation
// ─────────────────────────────────────────────────

/** Payload for Gemini — unchanged from the original inlineData contract. */
export function toGeminiParts(inputs) {
  return inputs.map((input) => ({ mimeType: input.mimeType, base64: input.base64 }));
}

export function hasAudio(inputs) {
  return inputs.some((input) => input.kind === "audio");
}

/**
 * Prepares local inference input.
 *
 * Returns one of:
 *   { mode: 'text', text }                        digital documents
 *   { mode: 'ocr', images }                       scans/photos, OCR pipeline
 *   { mode: 'vision', images }                    scans/photos, out of date
 *                                                 direct-VLM pipeline
 *
 * `ocr: true` is the Lite-tier path: a document-reader model turns pages into
 * text, then the text model performs structured extraction. The two models are
 * never resident at the same time.
 */
export async function prepareForLocal(inputs, { maxPages = DEFAULT_MAX_PDF_PAGES, ocr = false } = {}) {
  if (hasAudio(inputs)) {
    throw new AIError(
      AI_ERROR.OFFLINE_UNSUPPORTED,
      "Audio recordings need online AI. No offline speech-to-text model is installed — connect to the internet, or upload the invoice/bill as a PDF or image."
    );
  }

  const sources = [];
  const textChunks = [];
  const images = [];
  let allText = true;

  for (const input of inputs) {
    if (input.kind === "pdf") {
      const pdf = await extractPdfText(input.buffer);
      sources.push({
        kind: "pdf",
        pageCount: pdf.pageCount,
        usedText: pdf.hasUsableText,
      });

      if (pdf.hasUsableText) {
        textChunks.push(pdf.text);
      } else {
        allText = false;
        const pages = await renderPdfPages(input.buffer, { maxPages });
        images.push(...pages.map((page) => page.base64));
      }
      continue;
    }

    if (input.kind === "image") {
      allText = false;
      sources.push({ kind: "image", pageCount: 1, usedText: false });
      images.push(input.base64);
      continue;
    }
  }

  if (allText && textChunks.length > 0) {
    const combined = textChunks.join("\n\n").trim();
    return {
      mode: "text",
      text: combined.slice(0, MAX_TEXT_CHARS),
      truncated: combined.length > MAX_TEXT_CHARS,
      sources,
    };
  }

  if (images.length === 0) {
    throw new AIError(
      AI_ERROR.INPUT_INVALID,
      "No readable content was found in the uploaded document."
    );
  }

  return {
    mode: ocr ? "ocr" : "vision",
    images: images.slice(0, MAX_VISION_IMAGES),
    truncatedPages: images.length > MAX_VISION_IMAGES,
    sources,
  };
}

export default {
  normalizeInputs,
  extractPdfText,
  renderPdfPages,
  hasUsableText,
  toGeminiParts,
  prepareForLocal,
  hasAudio,
};
