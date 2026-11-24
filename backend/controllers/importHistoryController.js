import ExcelJS from "exceljs";
import repositories from "../../database/repositories/index.js";
import { getTenantContext } from "../utils/tenantHelper.js";

const { importHistoryRepository, productRepository, runInTransaction } = repositories;

const getImportHistory = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const history = importHistoryRepository.findAll(orgId);
    res.json(history);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getImportHistoryById = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const record = importHistoryRepository.findById(req.params.id, orgId);
    if (!record) {
      return res.status(404).json({ message: "Import record not found" });
    }
    res.json(record);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const createImportRecord = async (req, res) => {
  const { fileName, items } = req.body;

  if (!fileName || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "File name and non-empty items array are required" });
  }

  try {
    const orgId = await getTenantContext(req);

    const importRecord = runInTransaction(() => {
      let totalQuantity = 0;
      let totalValue = 0;
      const processedItems = [];

      for (const item of items) {
        if (!item.name || !item.sku) {
          const err = new Error("Each item must have a name and sku");
          err.statusCode = 400;
          throw err;
        }

        const qty = Number(item.quantity) || 0;
        const unitPrice = Number(item.price) || 0;
        let product = productRepository.findBySku(item.sku, orgId);
        let status = "Updated";

        if (product) {
          productRepository.incrementStock(product.id, qty);
          productRepository.update(product._id, {
            price: unitPrice,
            expiryDate: item.expiryDate || product.expiryDate,
            mfgDate: item.mfgDate || product.mfgDate,
            hsn: item.hsn || product.hsn,
            packaging: item.packaging || product.packaging || "1 Tablet",
            tabletsPerStrip: item.tabletsPerStrip || product.tabletsPerStrip || 1,
          });
        } else {
          status = "New";
          product = productRepository.create({
            organization: orgId,
            name: item.name,
            sku: item.sku,
            category: item.category || "General",
            quantity: qty,
            price: unitPrice,
            expiryDate: item.expiryDate || new Date(Date.now() + 365 * 2 * 24 * 60 * 60 * 1000).toISOString(),
            mfgDate: item.mfgDate || null,
            hsn: item.hsn || null,
            packaging: item.packaging || "1 Tablet",
            tabletsPerStrip: item.tabletsPerStrip || 1,
          });
        }

        totalQuantity += qty;
        totalValue += qty * unitPrice;

        processedItems.push({
          name: product.name,
          sku: product.sku,
          category: product.category,
          quantity: qty,
          price: unitPrice,
          status,
        });
      }

      return importHistoryRepository.create({
        organization: orgId,
        fileName: String(fileName).trim(),
        totalProducts: items.length,
        totalQuantity,
        totalValue,
        items: processedItems,
      });
    });

    res.status(201).json(importRecord);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const deleteImportRecord = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const record = importHistoryRepository.findById(req.params.id, orgId);
    if (!record) {
      return res.status(404).json({ message: "Import record not found" });
    }

    importHistoryRepository.delete(req.params.id, orgId);
    res.json({ message: "Import history record deleted successfully" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const exportImportHistory = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const record = importHistoryRepository.findById(req.params.id, orgId);
    if (!record) {
      return res.status(404).json({ message: "Import record not found" });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Mediblix Desktop";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Imported Catalog");
    sheet.columns = [
      { header: "#", key: "index", width: 6 },
      { header: "Medicine Name", key: "name", width: 28 },
      { header: "SKU", key: "sku", width: 18 },
      { header: "Category", key: "category", width: 18 },
      { header: "Quantity", key: "quantity", width: 12 },
      { header: "Price (₹)", key: "price", width: 14 },
      { header: "Total Value (₹)", key: "totalValue", width: 16 },
      { header: "Import Status", key: "status", width: 14 },
    ];

    // Header styling
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0F2FE" },
    };

    record.items.forEach((item, index) => {
      sheet.addRow({
        index: index + 1,
        name: item.name,
        sku: item.sku,
        category: item.category || "General",
        quantity: item.quantity,
        price: item.price,
        totalValue: (item.quantity * item.price).toFixed(2),
        status: item.status,
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=import-history-${record.fileName || record._id}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

export {
  getImportHistory,
  getImportHistoryById,
  createImportRecord,
  deleteImportRecord,
  exportImportHistory,
};
