/**
 * Mediblix Desktop — AI output validation & normalisation
 *
 * Model output (Gemini or local) is never trusted. Everything passes through
 * these validators before it reaches a controller response or the review UI, so
 * the frontend always receives the documented shape with sane values.
 *
 * Parsing does not write to the database; business writes stay in the existing
 * import-history and sales controllers.
 */

import { AI_ERROR, AIError } from "./aiErrors.js";

const MAX_ITEMS = 500;
const MAX_NAME_LENGTH = 200;
const MAX_TEXT_LENGTH = 2000;

// ─────────────────────────────────────────────────
// Loose JSON extraction
// ─────────────────────────────────────────────────

/**
 * Extracts the first JSON value from model text.
 * Handles markdown fences, leading prose and trailing commentary.
 */
export function parseLooseJSON(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new AIError(AI_ERROR.INVALID_OUTPUT, "The AI returned an empty response.", {
      provider: null,
    });
  }

  let cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/gi, "")
    .trim();

  const objStart = cleaned.indexOf("{");
  const arrStart = cleaned.indexOf("[");

  // Order candidates by where they start. An object such as
  // {"customerMobile":..., "items":[...]} contains an array, so extracting
  // the inner array first would silently discard the customer fields.
  const spans = [];
  if (objStart !== -1) {
    const end = cleaned.lastIndexOf("}");
    if (end > objStart) spans.push({ start: objStart, text: cleaned.slice(objStart, end + 1) });
  }
  if (arrStart !== -1) {
    const end = cleaned.lastIndexOf("]");
    if (end > arrStart) spans.push({ start: arrStart, text: cleaned.slice(arrStart, end + 1) });
  }

  const candidates = spans.sort((a, b) => a.start - b.start).map((span) => span.text);
  candidates.push(cleaned);

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
    // Common repair: trailing commas produced by smaller local models.
    const repaired = candidate.replace(/,\s*([}\]])/g, "$1");
    if (repaired !== candidate) {
      const parsedRepaired = tryParse(repaired);
      if (parsedRepaired !== undefined) return parsedRepaired;
    }
  }

  throw new AIError(
    AI_ERROR.INVALID_OUTPUT,
    "The AI response was not in a valid format. Please ensure the document contains a clear product list."
  );
}

function tryParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────
// Scalar normalisers
// ─────────────────────────────────────────────────

export function cleanString(value, maxLength = MAX_TEXT_LENGTH) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

export function normalizeNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  let num = null;

  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string") {
    const cleaned = value
      .replace(/[₹$€£]/g, "")
      .replace(/\b(rs|inr)\.?/gi, "")
      .replace(/,/g, "")
      .trim();
    const match = cleaned.match(/-?\d+(\.\d+)?/);
    if (match) num = Number(match[0]);
  }

  if (num === null || !Number.isFinite(num)) return null;

  if (integer) num = Math.round(num);
  if (num < min) return null;
  if (num > max) return max;

  return num;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function isValidYmd(year, month, day) {
  if (!year || !month || !day) return false;
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function expandYear(value) {
  const year = Number(value);
  if (value.length === 2) return 2000 + year;
  return year;
}

/**
 * Normalises the many date shapes found on Indian pharmacy invoices
 * (YYYY-MM-DD, DD/MM/YYYY, MM/YYYY, "05 Jan 2027") to YYYY-MM-DD.
 */
export function normalizeDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }

  let text = String(value).trim();
  if (!text) return null;
  if (/^(null|n\/?a|none|unknown|-|--)$/i.test(text)) return null;

  // Drop leading labels such as "Exp:" / "Mfg."
  text = text.replace(/^(exp(iry)?|mfg|mfd|manufactur\w*|use before)[\s:.\-]*/i, "").trim();

  // ISO / sortable
  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isValidYmd(year, month, day) ? `${year}-${pad2(month)}-${pad2(day)}` : null;
  }

  // 05 Jan 2027 / Jan 2027 / Jan-27
  m = text.match(/^(\d{1,2})?[\s\-/.]*([A-Za-z]{3,9})[\s\-/.]*(\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) {
      const year = expandYear(m[3]);
      if (m[1]) {
        const day = Number(m[1]);
        return isValidYmd(year, month, day) ? `${year}-${pad2(month)}-${pad2(day)}` : null;
      }
      return isValidYmd(year, month, lastDayOfMonth(year, month))
        ? `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`
        : null;
    }
  }

  // DD/MM/YYYY or DD-MM-YY
  m = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let first = Number(m[1]);
    let second = Number(m[2]);
    const year = expandYear(m[3]);
    // Prefer day-first (Indian convention), but accept MM/DD when unambiguous.
    let day = first;
    let month = second;
    if (first <= 12 && second > 12) {
      day = second;
      month = first;
    }
    return isValidYmd(year, month, day) ? `${year}-${pad2(month)}-${pad2(day)}` : null;
  }

  // MM/YYYY or MM/YY — expiry printed as month + year means end of month
  m = text.match(/^(\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const month = Number(m[1]);
    const year = expandYear(m[2]);
    const day = lastDayOfMonth(year, month);
    return isValidYmd(year, month, day) ? `${year}-${pad2(month)}-${pad2(day)}` : null;
  }

  // Last resort: anything the JS engine understands
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getUTCFullYear()}-${pad2(parsed.getUTCMonth() + 1)}-${pad2(parsed.getUTCDate())}`;
  }
  return null;
}

// ─────────────────────────────────────────────────
// SKU / batch generation
// ─────────────────────────────────────────────────

function slugFromName(name) {
  const base = String(name || "ITEM")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12);
  return base || "ITEM";
}

export function generateSku(name, index = 0, used = new Set()) {
  const base = `AI-${slugFromName(name)}`;
  let candidate = base;
  let counter = index + 1;
  while (used.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

// ─────────────────────────────────────────────────
// Invoice items
// ─────────────────────────────────────────────────

function extractItemArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    // Smaller local models sometimes wrap the array in a named key even when
    // asked for a bare array; that is the same data, not an error.
    for (const key of [
      "items",
      "products",
      "data",
      "result",
      "medicines",
      "lineItems",
      "invoiceLines",
      "invoice_items",
      "line_items",
      "rows",
    ]) {
      if (Array.isArray(raw[key])) return raw[key];
    }
    // A single item object
    if (raw.name || raw.itemName || raw.product) return [raw];
  }
  return null;
}

/**
 * Validates and normalises AI invoice extraction to the existing contract:
 * { name, sku, category, quantity, price, expiryDate, mfgDate, hsn, packaging, tabletsPerStrip }
 */
export function validateInvoiceItems(raw) {
  const array = extractItemArray(raw);
  if (array === null) {
    throw new AIError(
      AI_ERROR.INVALID_OUTPUT,
      "The AI did not return a product list. Please ensure the invoice is readable."
    );
  }
  if (array.length > MAX_ITEMS) {
    throw new AIError(
      AI_ERROR.INPUT_TOO_LARGE,
      `The AI extracted ${array.length} items, which exceeds the ${MAX_ITEMS}-item limit. Please split the document.`
    );
  }

  const usedSkus = new Set();
  const items = [];

  array.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;

    const name = cleanString(
      entry.name ?? entry.itemName ?? entry.product ?? entry.medicine ?? entry.description,
      MAX_NAME_LENGTH
    );
    if (!name) return;

    const quantity = normalizeNumber(entry.quantity ?? entry.qty ?? entry.units, {
      min: 0,
      max: 1_000_000,
      integer: true,
    });
    const price = normalizeNumber(entry.price ?? entry.unitPrice ?? entry.rate ?? entry.mrp, {
      min: 0,
      max: 1_000_000,
    });

    const skuRaw = cleanString(entry.sku ?? entry.batch ?? entry.batchNumber ?? entry.batchNo, 60);
    const sku = skuRaw && skuRaw.length >= 2 ? skuRaw.toUpperCase() : generateSku(name, index, usedSkus);
    if (skuRaw && skuRaw.length >= 2) usedSkus.add(sku);

    const packaging = cleanString(entry.packaging ?? entry.pack, 120) || "10 Tablets / Strip";
    const tabletsPerStrip =
      normalizeNumber(entry.tabletsPerStrip ?? entry.tablets ?? entry.unitsPerStrip, {
        min: 1,
        max: 10_000,
        integer: true,
      }) || 10;

    items.push({
      name,
      sku,
      category: cleanString(entry.category ?? entry.type, 80) || "General",
      quantity: quantity === null ? 1 : quantity,
      price: price === null ? 0 : price,
      expiryDate: normalizeDate(entry.expiryDate ?? entry.expiry ?? entry.exp),
      mfgDate: normalizeDate(entry.mfgDate ?? entry.manufacturingDate ?? entry.mfg),
      hsn: cleanString(entry.hsn ?? entry.hsnCode, 20),
      packaging,
      tabletsPerStrip,
    });
  });

  return items;
}

// ─────────────────────────────────────────────────
// Sales bill
// ─────────────────────────────────────────────────

const MAX_PHONE_DIGITS = 10;

export function normalizeMobile(value) {
  const text = cleanString(value, 40);
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  if (digits.length === MAX_PHONE_DIGITS) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return null;
}

/**
 * Validates and normalises bill extraction to the existing contract:
 * { customerName, customerMobile, items: [{ name, sku, quantity, price, discount, unit }] }
 */
export function validateBillPayload(raw) {
  let payload = raw;

  if (Array.isArray(raw)) {
    // A model may return only line items for a bill.
    payload = { customerName: null, customerMobile: null, items: raw };
  }

  if (!payload || typeof payload !== "object") {
    throw new AIError(
      AI_ERROR.INVALID_OUTPUT,
      "The AI did not return bill details. Please ensure the bill is readable."
    );
  }

  const itemArray = extractItemArray(payload) || [];
  if (itemArray.length > MAX_ITEMS) {
    throw new AIError(
      AI_ERROR.INPUT_TOO_LARGE,
      `The AI extracted ${itemArray.length} items, which exceeds the ${MAX_ITEMS}-item limit. Please split the document.`
    );
  }

  const usedSkus = new Set();
  const items = [];

  itemArray.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;

    const name = cleanString(
      entry.name ?? entry.itemName ?? entry.product ?? entry.medicine ?? entry.description,
      MAX_NAME_LENGTH
    );
    if (!name) return;

    items.push({
      name,
      sku:
        cleanString(entry.sku ?? entry.batch ?? entry.batchNumber, 60)?.toUpperCase() ||
        generateSku(name, index, usedSkus),
      quantity:
        normalizeNumber(entry.quantity ?? entry.qty ?? entry.units, {
          min: 1,
          max: 1_000_000,
          integer: true,
        }) || 1,
      price: normalizeNumber(entry.price ?? entry.unitPrice ?? entry.rate ?? entry.mrp, {
        min: 0,
        max: 1_000_000,
      }) ?? 0,
      discount: normalizeNumber(entry.discount ?? entry.discountPercent, {
        min: 0,
        max: 1_000_000,
      }) ?? 0,
      unit: cleanString(entry.unit, 40) || "Tablet",
    });
  });

  return {
    customerName: cleanString(
      payload.customerName ?? payload.customer?.name ?? payload.customer,
      MAX_NAME_LENGTH
    ),
    customerMobile: normalizeMobile(
      payload.customerMobile ?? payload.customerPhone ?? payload.customer?.mobile ?? payload.mobile
    ),
    items,
  };
}

// ─────────────────────────────────────────────────
// MedAgent payloads
// ─────────────────────────────────────────────────

export const INTENTS = ["symptom_query", "alternative_request", "app_guidance", "general_chat"];

export function validateIntent(raw) {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  const lower = text.toLowerCase();
  for (const intent of INTENTS) {
    if (lower.includes(intent)) return intent;
  }
  const words = lower.replace(/[^a-z_]/g, " ").trim();
  for (const intent of INTENTS) {
    if (words === intent) return intent;
  }
  return null;
}

export function validateAppGuidance(raw) {
  if (!raw || typeof raw !== "object") {
    throw new AIError(AI_ERROR.INVALID_OUTPUT, "The AI did not return a usable answer.");
  }
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((s) => cleanString(s, 400)).filter(Boolean).slice(0, 10)
    : null;
  const route = cleanString(raw.navigateTo, 120);
  const safeRoute = route && /^\/[a-z0-9\-/]*$/i.test(route) ? route : null;

  return {
    message: cleanString(raw.message, MAX_TEXT_LENGTH) || null,
    steps: steps && steps.length > 0 ? steps : null,
    navigateTo: safeRoute,
    pageTitle: cleanString(raw.pageTitle, 80),
  };
}

export function validateSymptomPayload(raw) {
  if (!raw || typeof raw !== "object") {
    throw new AIError(AI_ERROR.INVALID_OUTPUT, "The AI did not return a usable answer.");
  }

  const severityRaw = cleanString(raw.severity, 20)?.toLowerCase();
  const severity = ["mild", "moderate", "severe"].includes(severityRaw) ? severityRaw : "mild";

  const medicines = Array.isArray(raw.medicines)
    ? raw.medicines.slice(0, 6).map((med) => {
        if (!med || typeof med !== "object") return null;
        const genericName = cleanString(
          med.genericName ?? med.name ?? med.medicine,
          MAX_NAME_LENGTH
        );
        if (!genericName) return null;
        const brands = Array.isArray(med.commonBrandNames)
          ? med.commonBrandNames.map((b) => cleanString(b, 80)).filter(Boolean).slice(0, 4)
          : [];
        return {
          genericName,
          commonBrandNames: brands,
          category: cleanString(med.category, 80) || "General",
          dosageGuideline: cleanString(med.dosageGuideline ?? med.dosage, 400) || "",
          precaution: cleanString(med.precaution, 400) || "",
        };
      }).filter(Boolean)
    : [];

  return {
    condition: cleanString(raw.condition, 200) || "General symptoms",
    severity,
    doctorConsultRequired: Boolean(raw.doctorConsultRequired) || severity === "severe",
    medicines,
    generalAdvice: cleanString(raw.generalAdvice, 800) || "",
  };
}

export default {
  parseLooseJSON,
  cleanString,
  normalizeNumber,
  normalizeDate,
  normalizeMobile,
  generateSku,
  validateInvoiceItems,
  validateBillPayload,
  validateIntent,
  validateAppGuidance,
  validateSymptomPayload,
  INTENTS,
};
