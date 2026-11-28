import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

import localAIService from "../services/localAIService.js";
import documentProcessor from "../services/documentProcessor.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
const catalog = require("../../electron/ai-model-catalog.json");
const { createLocalAISupervisor } = require("../../electron/local-ai-supervisor.js");
const { createAIControlServer } = require("../../electron/ai-control-server.js");

const MODEL_DIR = path.join(os.homedir(), "Library", "Application Support", "Mediblix", "ai-models");
const PROMPT = `You are an expert pharmaceutical invoice parser. Extract every medicine line item. Return a raw JSON array where each item has exactly: name (string), sku (string, the batch number), category (string), quantity (number), price (number), expiryDate (string YYYY-MM-DD or null), mfgDate (string or null), hsn (string or null), packaging (string), tabletsPerStrip (number). Return only the JSON array.`;

const rowsA = [
  ["Product", "Batch", "Category", "Qty", "Rate", "Expiry"],
  ["Paracetamol 500mg Tablet", "BAT-101", "Analgesics", "120", "2.50", "2027-08-31"],
  ["Amoxicillin 250mg Capsule", "BAT-102", "Antibiotics", "60", "8.75", "2027-05-31"],
];
const rowsB = [
  ["Product", "Batch", "Category", "Qty", "Rate", "Expiry"],
  ["Metformin 500mg Tablet", "BAT-103", "Diabetes", "90", "4.20", "2028-01-31"],
  ["Cetirizine 10mg Tablet", "BAT-104", "Antihistamines", "45", "1.80", "2027-11-30"],
];

function pdf(file, pages) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    pages.forEach((rows, i) => {
      if (i > 0) doc.addPage();
      doc.fontSize(18).text("MEDIPLUS DISTRIBUTORS PVT LTD");
      doc.fontSize(9).text("12 MG Road, Bengaluru 560001  |  GSTIN 29AABCM1234C1ZP");
      doc.moveDown(0.5);
      doc.fontSize(11).text(`TAX INVOICE   No: INV-2026-0912    Date: 2026-09-12`);
      doc.moveDown();
      for (const row of rows) doc.fontSize(10).text(row.join("   |   "));
      doc.moveDown();
      doc.fontSize(10).text("Subtotal: 1243.50    GST 12%: 149.22    Grand total: 1392.72");
    });
    doc.end();
    stream.on("finish", () => resolve(file));
    stream.on("error", reject);
  });
}

const supervisor = createLocalAISupervisor({
  catalog,
  modelDir: MODEL_DIR,
  devRoot: projectRoot,
  resourcesPath: null,
  tier: "lite",
});
const control = createAIControlServer({ supervisor });
const { url, token } = await control.listen();
process.env.MEDIBLIX_AI_CONTROL_URL = url;
process.env.MEDIBLIX_AI_CONTROL_TOKEN = token;
process.env.MEDIBLIX_MODEL_DIR = MODEL_DIR;
process.env.MEDIBLIX_AI_TIER = "lite";
process.env.MEDIBLIX_SCAN_OCR = "on";
localAIService.resetHealthCache();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-"));
try {
  const base = path.join(tmp, "two.pdf");
  await pdf(base, [rowsA, rowsB]);
  const pages = await documentProcessor.renderPdfPages(fs.readFileSync(base), { maxPages: 2, desiredWidth: 1400 });

  // Scanned PDF: images only, two pages.
  const scanned = path.join(tmp, "scanned.pdf");
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const stream = fs.createWriteStream(scanned);
    doc.pipe(stream);
    pages.forEach((page, i) => {
      if (i > 0) doc.addPage();
      doc.image(Buffer.from(page.base64, "base64"), 40, 40, { width: doc.page.width - 80 });
    });
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  const buffer = fs.readFileSync(scanned);
  const inputs = documentProcessor.normalizeInputs({ fileData: buffer.toString("base64"), mimeType: "application/pdf" });
  const prepared = await documentProcessor.prepareForLocal(inputs, { ocr: true });
  console.log("prepared:", prepared.mode, "images:", prepared.images.length);

  const ocr = await localAIService.ocrImages(prepared.images, { prompt: "OCR:", maxTokens: 2048 });
  console.log("\n--- OCR pages:", ocr.pages, "read:", ocr.readPages, "chars:", ocr.text.length);
  console.log(ocr.text.slice(0, 900));
  console.log("...\n--- tail ---");
  console.log(ocr.text.slice(-400));

  await localAIService.unloadModel("vision").catch(() => {});
  const chat = await localAIService.chatJSON({
    prompt: `${PROMPT}\n\nDOCUMENT TEXT (transcribed from page images by OCR; recognition errors are possible):\n${ocr.text}`,
    numPredict: 1600,
    kind: "text",
  });
  console.log("\n--- chat model:", chat.model, "duration:", chat.durationMs);
  console.log("parsed type:", Array.isArray(chat.data) ? "array" : typeof chat.data, "len:", Array.isArray(chat.data) ? chat.data.length : "-");
  console.log(JSON.stringify(chat.data).slice(0, 1500));
} finally {
  await supervisor.stopAll();
  await control.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
