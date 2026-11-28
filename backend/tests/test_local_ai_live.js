/**
 * Mediblix Desktop — LIVE offline AI test (real models, real runtime)
 *
 * Deliberately NOT part of `npm test`: it needs the downloaded Lite models and
 * spawns real `llama-server` processes. It is the test that proves inference
 * actually works, as opposed to the mocked suites.
 *
 *   node backend/tests/test_local_ai_live.js
 *
 * Exit codes: 0 = pass, 1 = failure, 2 = blocked (models/runtime missing).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import sharp from "sharp";

import aiProvider from "../services/aiProvider.js";
import localAIService from "../services/localAIService.js";
import documentProcessor from "../services/documentProcessor.js";
import { validateInvoiceItems, validateBillPayload } from "../services/extractionValidator.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

const catalog = require("../../electron/ai-model-catalog.json");
const { createLocalAISupervisor } = require("../../electron/local-ai-supervisor.js");
const { createAIControlServer } = require("../../electron/ai-control-server.js");

const MODEL_DIR =
  process.env.MEDIBLIX_MODEL_DIR ||
  path.join(os.homedir(), "Library", "Application Support", "Mediblix", "ai-models");

const INVOICE_PROMPT = `You are an expert pharmaceutical invoice parser. Extract every medicine line item. Return a raw JSON array where each item has exactly: name (string), sku (string, the batch number), category (string), quantity (number), price (number), expiryDate (string YYYY-MM-DD or null), mfgDate (string or null), hsn (string or null), packaging (string), tabletsPerStrip (number). Return only the JSON array.`;

const BILL_PROMPT = `You are an expert pharmacy sales-bill parser. Return a raw JSON object with exactly: customerName (string or null), customerMobile (10 digit string or null), items (array of {name, sku, quantity, price, unit}). Return only the JSON object.`;

const STARTED = Date.now();
const phases = [];
const record = (name, status, detail) => {
  phases.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : status === "PARTIAL" ? "~" : "✗";
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
};

function missingModels() {
  const lite = catalog.tiers.lite.models;
  const missing = [];
  for (const [kind, spec] of Object.entries(lite)) {
    for (const file of spec.files) {
      const full = path.join(MODEL_DIR, file.name);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        missing.push(`${kind}: ${file.name} (missing)`);
        continue;
      }
      if (stat.size !== file.bytes) missing.push(`${kind}: ${file.name} (${stat.size} of ${file.bytes} bytes)`);
    }
  }
  return missing;
}

// ── fixtures ───────────────────────────────────────────────────────────────

function createPdf(filePath, pageBuilders) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    pageBuilders.forEach((build, index) => {
      if (index > 0) doc.addPage();
      build(doc);
    });
    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

const INVOICE_ROWS_A = [
  ["Product", "Batch", "Category", "Qty", "Rate", "Expiry"],
  ["Paracetamol 500mg Tablet", "BAT-101", "Analgesics", "120", "2.50", "2027-08-31"],
  ["Amoxicillin 250mg Capsule", "BAT-102", "Antibiotics", "60", "8.75", "2027-05-31"],
];
const INVOICE_ROWS_B = [
  ["Product", "Batch", "Category", "Qty", "Rate", "Expiry"],
  ["Metformin 500mg Tablet", "BAT-103", "Diabetes", "90", "4.20", "2028-01-31"],
  ["Cetirizine 10mg Tablet", "BAT-104", "Antihistamines", "45", "1.80", "2027-11-30"],
];

function invoicePage(rows, heading = "TAX INVOICE") {
  return (doc) => {
    doc.fontSize(18).text("MEDIPLUS DISTRIBUTORS PVT LTD");
    doc.fontSize(9).text("12 MG Road, Bengaluru 560001  |  GSTIN 29AABCM1234C1ZP");
    doc.moveDown(0.5);
    doc.fontSize(11).text(`${heading}   No: INV-2026-0912    Date: 2026-09-12`);
    doc.text("Supplier: Mediphus Distributors    Payment: 30 days");
    doc.moveDown();
    for (const row of rows) doc.fontSize(10).text(row.join("   |   "));
    doc.moveDown();
    doc.fontSize(10).text("Subtotal: 1243.50    GST 12%: 149.22    Grand total: 1392.72");
  };
}

function billPage(doc) {
  doc.fontSize(18).text("MEDIPLUS PHARMACY");
  doc.fontSize(9).text("12 MG Road, Bengaluru 560001  |  Ph: 080-4000-1234");
  doc.moveDown(0.5);
  doc.fontSize(11).text("CUSTOMER BILL   No: SB-2026-4471   Date: 2026-09-12");
  doc.fontSize(10).text("Customer: Ravi Kumar    Mobile: 9876543210");
  doc.moveDown();
  doc.fontSize(10).text("Item   |   Qty   |   Rate   |   Amount");
  doc.fontSize(10).text("Paracetamol 500mg Tablet   |   2   |   2.50   |   5.00");
  doc.fontSize(10).text("Amoxicillin 250mg Capsule  |   1   |   8.75   |   8.75");
  doc.moveDown();
  doc.fontSize(10).text("Total: 13.75    Payment: Cash");
}

/** Turns rendered page PNGs into an image-only (scanned) PDF. */
async function createScannedPdf(filePath, pngBuffers) {
  return createPdf(
    filePath,
    pngBuffers.map((png) => (doc) => {
      const width = doc.page.width - 80;
      doc.image(png, 40, 40, { width });
    })
  );
}

function assertInvoiceContract(items, label) {
  assert.ok(Array.isArray(items) && items.length >= 1, `${label}: items array`);
  const first = items[0];
  assert.equal(typeof first.name, "string", `${label}: name is a string`);
  assert.equal(typeof first.sku, "string", `${label}: sku is a string`);
  assert.equal(typeof first.quantity, "number", `${label}: quantity is a number`);
  assert.equal(typeof first.price, "number", `${label}: price is a number`);
  assert.ok(
    first.expiryDate === null || /^\d{4}-\d{2}-\d{2}$/.test(first.expiryDate),
    `${label}: expiry is null or YYYY-MM-DD`
  );
}

const namesOf = (items) => items.map((item) => String(item.name || "").toLowerCase());

async function main() {
  console.log("Mediblix live offline AI test");
  console.log(`  model dir : ${MODEL_DIR}`);
  console.log(`  platform  : ${process.platform}-${process.arch}, ${os.cpus().length} cores, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM`);

  const missing = missingModels();
  if (missing.length) {
    console.log("\nBLOCKED: the Lite models are not installed:");
    for (const item of missing) console.log(`  - ${item}`);
    process.exit(2);
  }

  const supervisor = createLocalAISupervisor({
    catalog,
    modelDir: MODEL_DIR,
    devRoot: projectRoot,
    resourcesPath: null,
    tier: "lite",
    env: { ...process.env, MEDIBLIX_AI_TIER: "lite" },
  });

  if (!supervisor.resolveBinary()) {
    console.log("\nBLOCKED: the bundled llama-server binary was not found in build/runtime.");
    process.exit(2);
  }

  // The backend reads its configuration per request, so these can be set here.
  process.env.MEDIBLIX_AI_TIER = "lite";
  process.env.MEDIBLIX_MODEL_DIR = MODEL_DIR;
  process.env.MEDIBLIX_LOCAL_SINGLE_MODEL = "1";
  delete process.env.MEDIBLIX_LOCAL_AI;
  delete process.env.GEMINI_API_KEY;

  const control = createAIControlServer({ supervisor });
  const { url, token } = await control.listen();
  process.env.MEDIBLIX_AI_CONTROL_URL = url;
  process.env.MEDIBLIX_AI_CONTROL_TOKEN = token;
  localAIService.resetHealthCache();
  aiProvider.resetCaches();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediblix-live-"));

  try {
    // ── 1. Runtime + text model ────────────────────────────────────────────
    let startedAt = Date.now();
    const ensure = await supervisor.ensureModel("text");
    assert.equal(ensure.ok, true, `text slot failed: ${ensure.message || ensure.reason}`);
    record("text model loads through the bundled runtime", "PASS", `${Date.now() - startedAt} ms`);

    const health = await localAIService.checkHealth({ force: true });
    assert.equal(health.available, true);
    assert.equal(health.textModelReady, true);

    // ── 2. MedAgent chat ───────────────────────────────────────────────────
    startedAt = Date.now();
    const chat = await aiProvider.generateTextJSON({
      system: "You are a pharmacy inventory assistant.",
      prompt: 'Return JSON exactly like {"status":"ok","engine":"local"}.',
      validate: (value) => value,
    });
    assert.equal(chat.provider, "local");
    assert.ok(chat.data && typeof chat.data === "object", "chat returned JSON");
    record("MedAgent chat answered offline", "PASS", `${Date.now() - startedAt} ms, model ${chat.model}`);

    // ── 3. Digital PDF invoice ─────────────────────────────────────────────
    const invoicePath = path.join(tmpDir, "invoice.pdf");
    await createPdf(invoicePath, [invoicePage([...INVOICE_ROWS_A, ...INVOICE_ROWS_B.slice(1)])]);
    const invoiceBuffer = fs.readFileSync(invoicePath);

    const extracted = await documentProcessor.extractPdfText(invoiceBuffer);
    assert.equal(extracted.hasUsableText, true, "digital test PDF must carry a text layer");

    startedAt = Date.now();
    const textResult = await aiProvider.generateDocumentJSON({
      feature: "invoice",
      inputs: documentProcessor.normalizeInputs({
        fileData: invoiceBuffer.toString("base64"),
        mimeType: "application/pdf",
      }),
      prompt: INVOICE_PROMPT,
      validate: validateInvoiceItems,
    });
    assert.equal(textResult.provider, "local");
    assertInvoiceContract(textResult.data, "digital invoice");
    const textNames = namesOf(textResult.data);
    assert.ok(
      textNames.some((name) => name.includes("paracetamol")) && textNames.some((name) => name.includes("metformin")),
      `expected medicine names, got: ${textNames.join(", ")}`
    );
    record("Digital PDF invoice extracted offline", "PASS", `${Date.now() - startedAt} ms, ${textResult.data.length} items, mode=${textResult.mode}`);

    // ── 4. Digital PDF bill ────────────────────────────────────────────────
    const billPath = path.join(tmpDir, "bill.pdf");
    await createPdf(billPath, [billPage]);
    const billBuffer = fs.readFileSync(billPath);

    startedAt = Date.now();
    const billResult = await aiProvider.generateDocumentJSON({
      feature: "bill",
      inputs: documentProcessor.normalizeInputs({
        fileData: billBuffer.toString("base64"),
        mimeType: "application/pdf",
      }),
      prompt: BILL_PROMPT,
      validate: validateBillPayload,
    });
    assert.equal(billResult.provider, "local");
    assert.equal(billResult.mode, "text");
    assert.ok(Array.isArray(billResult.data.items) && billResult.data.items.length >= 1, "bill items array");
    assert.match(String(billResult.data.customerMobile || "").replace(/\D/g, ""), /^\d{10}$/, "bill mobile is 10 digits");
    assert.ok(String(billResult.data.customerName || "").toLowerCase().includes("ravi"), "bill customer name");
    assert.equal(typeof billResult.data.items[0].quantity, "number", "bill quantity is a number");
    record(
      "Digital PDF bill parsed offline",
      "PASS",
      `${Date.now() - startedAt} ms, ${billResult.data.items.length} items, mobile ${billResult.data.customerMobile}`
    );

    // ── 5. Rendered pages + scanned fixtures ──────────────────────────────
    const multiPagePdf = path.join(tmpDir, "invoice-2-pages.pdf");
    await createPdf(multiPagePdf, [invoicePage(INVOICE_ROWS_A), invoicePage(INVOICE_ROWS_B, "TAX INVOICE (CONTINUED)")]);
    const multiPageBuffer = fs.readFileSync(multiPagePdf);
    const renderedPages = await documentProcessor.renderPdfPages(multiPageBuffer, { maxPages: 2, desiredWidth: 1400 });
    assert.equal(renderedPages.length, 2, "two pages rendered");

    const pageOnePng = Buffer.from(renderedPages[0].base64, "base64");
    const pageTwoPng = Buffer.from(renderedPages[1].base64, "base64");

    const scannedPath = path.join(tmpDir, "scanned.pdf");
    await createScannedPdf(scannedPath, [pageOnePng]);
    const scannedBuffer = fs.readFileSync(scannedPath);
    const scannedText = await documentProcessor.extractPdfText(scannedBuffer);
    assert.equal(scannedText.hasUsableText, false, "scanned PDF must not have a usable text layer");

    const multiScannedPath = path.join(tmpDir, "scanned-2-pages.pdf");
    await createScannedPdf(multiScannedPath, [pageOnePng, pageTwoPng]);
    const multiScannedBuffer = fs.readFileSync(multiScannedPath);

    const jpegBuffer = await sharp(pageOnePng).jpeg({ quality: 92 }).toBuffer();

    // ── 6. OCR gate: scans are refused unless the pipeline is enabled ─────
    process.env.MEDIBLIX_SCAN_OCR = "off";
    await assert.rejects(
      () =>
        aiProvider.generateDocumentJSON({
          feature: "invoice",
          inputs: documentProcessor.normalizeInputs({ fileData: pageOnePng.toString("base64"), mimeType: "image/png" }),
          prompt: INVOICE_PROMPT,
          validate: validateInvoiceItems,
        }),
      (error) => error.code === "AI_OFFLINE_UNSUPPORTED",
      "scans must be refused while the OCR pipeline is disabled"
    );
    record("OCR pipeline stays opt-in (clear refusal, no silent result)", "PASS");

    process.env.MEDIBLIX_SCAN_OCR = "on";
    aiProvider.resetCaches();

    // ── 7. OCR cases ──────────────────────────────────────────────────────
    const runScan = async (label, { base64, mimeType }, { expectNames = [], minItems = 1 } = {}) => {
      const started = Date.now();
      let result;
      try {
        result = await aiProvider.generateDocumentJSON({
          feature: "invoice",
          inputs: documentProcessor.normalizeInputs({ fileData: base64, mimeType }),
          prompt: INVOICE_PROMPT,
          validate: validateInvoiceItems,
        });
      } catch (error) {
        record(label, "FAILED", `${error.code}: ${error.message}`);
        throw error;
      }

      assert.equal(result.mode, "ocr", `${label}: OCR pipeline used`);
      assertInvoiceContract(result.data, label);

      const found = namesOf(result.data);
      const matched = expectNames.filter((name) => found.some((item) => item.includes(name))).length;
      assert.ok(
        result.data.length >= minItems,
        `${label}: expected at least ${minItems} item(s), got ${result.data.length}`
      );
      if (expectNames.length) {
        assert.ok(
          matched >= Math.ceil(expectNames.length / 2),
          `${label}: expected ~${expectNames.length} known medicines, matched ${matched} (${found.join(", ")})`
        );
      }
      record(
        label,
        matched === expectNames.length ? "PASS" : "PARTIAL",
        `${Date.now() - started} ms, ${result.data.length} items, ${result.ocr?.grounded ?? "?"}/${result.ocr?.items ?? "?"} grounded`
      );
      return result;
    };

    await runScan(
      "Scanned PDF (image only)",
      { base64: scannedBuffer.toString("base64"), mimeType: "application/pdf" },
      { expectNames: ["paracetamol", "amoxicillin"] }
    );

    const multiScan = await runScan(
      "Multi-page scanned PDF (2 pages)",
      { base64: multiScannedBuffer.toString("base64"), mimeType: "application/pdf" },
      { expectNames: ["paracetamol", "amoxicillin", "metformin", "cetirizine"], minItems: 3 }
    );
    assert.equal(multiScan.ocr?.readPages, 2, "both scanned pages were read");

    await runScan("PNG photo", { base64: pageOnePng.toString("base64"), mimeType: "image/png" }, {
      expectNames: ["paracetamol", "amoxicillin"],
    });
    await runScan("JPEG photo", { base64: jpegBuffer.toString("base64"), mimeType: "image/jpeg" }, {
      expectNames: ["paracetamol", "amoxicillin"],
    });
    await runScan("JPG alias", { base64: jpegBuffer.toString("base64"), mimeType: "image/jpg" }, {
      expectNames: ["paracetamol"],
    });

    // ── 8. Scanned bill (OCR → bill contract) ─────────────────────────────
    {
      const billPages = await documentProcessor.renderPdfPages(billBuffer, { maxPages: 1, desiredWidth: 1400 });
      const billPng = Buffer.from(billPages[0].base64, "base64");
      const started = Date.now();
      const result = await aiProvider.generateDocumentJSON({
        feature: "bill",
        inputs: documentProcessor.normalizeInputs({ fileData: billPng.toString("base64"), mimeType: "image/png" }),
        prompt: BILL_PROMPT,
        validate: validateBillPayload,
      });
      assert.equal(result.mode, "ocr");
      assert.ok(Array.isArray(result.data.items) && result.data.items.length >= 1, "scanned bill items");
      record("Scanned bill read by OCR", "PASS", `${Date.now() - started} ms, ${result.data.items.length} items`);
    }

    // ── 9. Shutdown ───────────────────────────────────────────────────────
    await supervisor.stopAll();
    const ownership = Object.values(supervisor.getOwnership());
    assert.ok(ownership.every((slot) => !slot.startedByUs), "no runtime left running");
    record("Runtime processes released", "PASS");
  } finally {
    try {
      await supervisor.stopAll();
    } catch {}
    try {
      await control.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = phases.filter((phase) => phase.status === "FAILED");
  const partial = phases.filter((phase) => phase.status === "PARTIAL");
  console.log(
    `\n${phases.length - failed.length - partial.length}/${phases.length} passed, ${partial.length} partial, ${failed.length} failed in ${((Date.now() - STARTED) / 1000).toFixed(1)}s`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nLIVE TEST FAILED:", error.message);
  if (error.stack) console.error(error.stack.split("\n").slice(0, 8).join("\n"));
  process.exit(1);
});
