import PDFDocument from "pdfkit";
import repositories from "../../database/repositories/index.js";
import { getTenantContext } from "../utils/tenantHelper.js";

const { saleRepository, organizationRepository } = repositories;

const createSale = async (req, res) => {
  const { customerId, items, paymentMethod, invoiceNumber } = req.body;

  try {
    const orgId = await getTenantContext(req);

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Sale must contain at least one item" });
    }

    const sale = saleRepository.createSale({
      orgId,
      customerId,
      items,
      paymentMethod,
      invoiceNumber,
    });

    res.status(201).json(sale);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getSales = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const query = { organization: orgId };
    if (req.query.customer) {
      query.customer = req.query.customer;
    }
    const sales = saleRepository.findAll(query);
    res.json(sales);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const generateInvoice = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const sale = saleRepository.findById(req.params.id, orgId);

    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }

    const org = sale.organization ? organizationRepository.findById(sale.organization) : null;
    const orgName = org ? org.name : "Mediblix Pharmacy";
    const orgAddress = org && org.address ? org.address : "Main Street Hub";
    const orgPhone = org && org.contactPhone ? org.contactPhone : "+91 99999 88888";
    const orgEmail = org && org.contactEmail ? org.contactEmail : "support@Mediblix.com";

    const doc = new PDFDocument({ margin: 50 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=invoice-${sale.invoiceNumber}.pdf`
    );

    doc.pipe(res);

    doc.lineWidth(1.5).strokeColor("#166534").roundedRect(50, 45, 36, 36, 6).stroke();
    doc.fillColor("#166534").font("Helvetica-Bold").fontSize(16).text("Rx", 50, 55, { width: 36, align: "center" });

    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(16).text(orgName, 98, 45);
    doc.fillColor("#6b7280").font("Helvetica").fontSize(8.5)
      .text(orgAddress, 98, 63)
      .text(`Phone: ${orgPhone} | ${orgEmail}`, 98, 73);

    doc.fillColor("#166534").font("Helvetica-Bold").fontSize(20).text("TAX INVOICE", 400, 45, { align: "right" });
    doc.fillColor("#6b7280").font("Helvetica").fontSize(9)
      .text(`Invoice #: ${sale.invoiceNumber}`, 400, 68, { align: "right" })
      .text(`Date: ${new Date(sale.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`, 400, 80, { align: "right" })
      .text(`Payment: ${sale.paymentMethod}`, 400, 92, { align: "right" });

    doc.moveTo(50, 110).lineTo(545, 110).lineWidth(1).strokeColor("#e5e7eb").stroke();

    const customer = sale.customer || { name: "Cash Customer", mobile: "N/A" };
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text("BILLED TO:", 50, 122);
    doc.font("Helvetica-Bold").fontSize(10).text(customer.name, 50, 136);
    doc.font("Helvetica").fontSize(9).fillColor("#4b5563")
      .text(`Phone: ${customer.mobile}`, 50, 149)
      .text(`Email: ${customer.email || "N/A"}`, 50, 161);

    const tableTop = 185;
    doc.fillColor("#f3f4f6").rect(50, tableTop, 495, 22).fill();

    doc.fillColor("#374151").font("Helvetica-Bold").fontSize(8.5)
      .text("#", 56, tableTop + 6, { width: 20 })
      .text("Item / Medicine", 80, tableTop + 6, { width: 170 })
      .text("Packaging", 255, tableTop + 6, { width: 75 })
      .text("Qty", 335, tableTop + 6, { width: 35, align: "center" })
      .text("Rate", 375, tableTop + 6, { width: 45, align: "right" })
      .text("Disc%", 425, tableTop + 6, { width: 35, align: "right" })
      .text("Amount", 465, tableTop + 6, { width: 75, align: "right" });

    let position = tableTop + 24;

    sale.items.forEach((item, index) => {
      const prodName = item.product ? item.product.name : "Unknown Item";
      const pkg = item.product ? (item.product.packaging || "10 Tablets / Strip") : "Tablet";
      const itemPrice = item.price || 0;
      const disc = item.discount || 0;
      const lineTotal = itemPrice * item.quantity * (1 - disc / 100);

      doc.font("Helvetica").fontSize(8.5).fillColor("#1f2937")
        .text(String(index + 1), 56, position + 6, { width: 20 })
        .text(prodName, 80, position + 6, { width: 170 })
        .text(pkg, 255, position + 6, { width: 75 })
        .text(String(item.quantity), 335, position + 6, { width: 35, align: "center" })
        .text(`Rs. ${itemPrice.toFixed(2)}`, 375, position + 6, { width: 45, align: "right" })
        .text(`${disc}%`, 425, position + 6, { width: 35, align: "right" })
        .text(`Rs. ${lineTotal.toFixed(2)}`, 465, position + 6, { width: 75, align: "right" });

      position += 24;
    });

    const summaryY = position + 10;
    const taxableValue = (sale.totalAmount / 1.18).toFixed(2);
    const cgst = ((sale.totalAmount - taxableValue) / 2).toFixed(2);
    const sgst = cgst;

    doc.font("Helvetica").fontSize(9).fillColor("#4b5563")
      .text("Taxable Value", 350, summaryY, { width: 80, align: "right" })
      .text("CGST @ 9%", 350, summaryY + 14, { width: 80, align: "right" })
      .text("SGST @ 9%", 350, summaryY + 28, { width: 80, align: "right" });

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827")
      .text(`Rs. ${taxableValue}`, 440, summaryY, { width: 100, align: "right" })
      .text(`Rs. ${cgst}`, 440, summaryY + 14, { width: 100, align: "right" })
      .text(`Rs. ${sgst}`, 440, summaryY + 28, { width: 100, align: "right" });

    const totalBannerY = summaryY + 46;
    doc.fillColor("#eaf5ed").rect(350, totalBannerY, 195, 28).fill();

    doc.fillColor("#166534").font("Helvetica-Bold").fontSize(10.5)
      .text("Grand Total", 365, totalBannerY + 9)
      .text(`Rs. ${sale.totalAmount.toFixed(2)}`, 440, totalBannerY + 9, { width: 100, align: "right" });

    const footerY = totalBannerY + 80;
    doc.moveTo(50, footerY - 15).lineTo(545, footerY - 15).lineWidth(1).strokeColor("#e5e7eb").stroke();

    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#374151").text("Terms & Conditions:", 50, footerY);
    doc.font("Helvetica").fontSize(8).fillColor("#6b7280")
      .text("1. Medicines once sold cannot be returned without a valid batch verification.", 50, footerY + 14)
      .text("2. Please store medicines as per directed guidelines. Keep out of reach of children.", 50, footerY + 24);

    doc.font("Helvetica-Oblique").fontSize(9.5).fillColor("#166534")
      .text(`Thank you for choosing ${orgName}. Get well soon!`, 50, footerY + 50, { align: "center", width: 495 });

    doc.end();
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const processReturn = async (req, res) => {
  const { itemId, returnQuantity } = req.body;

  try {
    const orgId = await getTenantContext(req);
    const updatedSale = saleRepository.processReturn({
      saleId: req.params.id,
      itemId,
      returnQuantity,
      orgId,
    });

    res.json(updatedSale);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

export { createSale, getSales, generateInvoice, processReturn };
