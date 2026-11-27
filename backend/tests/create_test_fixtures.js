/**
 * Mediblix Desktop — Synthetic Document & Image Fixture Generator
 *
 * Generates non-sensitive, realistic test documents for:
 * 1. Image invoice (PNG) with known expected fields
 * 2. Scanned PDF (single image page, zero text layer)
 * 3. Text PDF invoice
 * 4. Image customer bill (PNG)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const PDFDocument = require("pdfkit");
const { pdfToPng } = require("pdf-to-png-converter");

export async function generateFixtures() {
  const fixturesDir = path.join(__dirname, "fixtures");
  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }

  // 1. Generate text-based PDF invoice
  const textPdfPath = path.join(fixturesDir, "sample_invoice.pdf");
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const stream = fs.createWriteStream(textPdfPath);
  doc.pipe(stream);

  doc.fontSize(18).text("MEDIBLIX WHOLESALE PHARMACEUTICALS", { align: "center" });
  doc.fontSize(10).text("TAX INVOICE / PURCHASE SHEET", { align: "center" });
  doc.moveDown();

  doc.fontSize(11).text("Invoice No: INV-2026-0892       Date: 2026-04-15");
  doc.text("Supplier: Cipla Pharmaceuticals Ltd.");
  doc.moveDown();

  doc.text("--------------------------------------------------------------------------------------------------------");
  doc.text("Item Name                  Batch/SKU    Qty    Price    Expiry Date   HSN");
  doc.text("--------------------------------------------------------------------------------------------------------");
  doc.text("Amoxicillin 500mg          AMX-501      50     120.00   2027-05-31    3004");
  doc.text("Paracetamol 650mg          PARA-65      100    30.00    2026-12-31    3004");
  doc.text("--------------------------------------------------------------------------------------------------------");
  doc.text("Total Quantity: 150                      Total Amount: Rs. 9,000.00");
  doc.end();

  await new Promise((resolve) => stream.on("finish", resolve));

  // 2. Render page 1 to PNG image for Image Invoice Testing
  const pngPages = await pdfToPng(textPdfPath, { viewportScale: 2.0 });
  const invoicePngPath = path.join(fixturesDir, "sample_invoice.png");
  fs.writeFileSync(invoicePngPath, pngPages[0].content);

  // 3. Generate a Scanned PDF (PDF containing ONLY the rendered image, 0 text layer)
  const scannedPdfPath = path.join(fixturesDir, "sample_scanned_invoice.pdf");
  const scanDoc = new PDFDocument({ size: "A4", margin: 0 });
  const scanStream = fs.createWriteStream(scannedPdfPath);
  scanDoc.pipe(scanStream);
  scanDoc.image(invoicePngPath, 0, 0, { width: 595, height: 842 });
  scanDoc.end();
  await new Promise((resolve) => scanStream.on("finish", resolve));

  // 4. Generate a Customer Sales Bill Image
  const billPdfPath = path.join(fixturesDir, "sample_bill.pdf");
  const billDoc = new PDFDocument({ size: "A4", margin: 40 });
  const billStream = fs.createWriteStream(billPdfPath);
  billDoc.pipe(billStream);

  billDoc.fontSize(18).text("MEDIBLIX PHARMACY RETAIL COUNTER", { align: "center" });
  billDoc.fontSize(10).text("RETAIL SALES BILL / CASH MEMO", { align: "center" });
  billDoc.moveDown();

  billDoc.fontSize(11).text("Customer Name: Rajesh Kumar");
  billDoc.text("Mobile: 9876543210");
  billDoc.text("Bill No: BILL-9021                   Date: 2026-11-27");
  billDoc.moveDown();

  billDoc.text("--------------------------------------------------------------------------------------------------------");
  billDoc.text("Item Name                  Batch/SKU    Qty    Price    Unit");
  billDoc.text("--------------------------------------------------------------------------------------------------------");
  billDoc.text("Azithromycin 500mg         AZI-101      3      125.00   Strip");
  billDoc.text("Cetirizine 10mg            CET-202      10     3.50     Tablet");
  billDoc.text("--------------------------------------------------------------------------------------------------------");
  billDoc.text("Grand Total: Rs. 410.00");
  billDoc.end();
  await new Promise((resolve) => billStream.on("finish", resolve));

  const billPngPages = await pdfToPng(billPdfPath, { viewportScale: 2.0 });
  const billPngPath = path.join(fixturesDir, "sample_bill.png");
  fs.writeFileSync(billPngPath, billPngPages[0].content);

  console.log("✓ Generated synthetic test fixtures in:", fixturesDir);
  return {
    textPdfPath,
    invoicePngPath,
    scannedPdfPath,
    billPngPath,
  };
}

// Direct execution test
if (process.argv[1] && process.argv[1].endsWith("create_test_fixtures.js")) {
  generateFixtures();
}
