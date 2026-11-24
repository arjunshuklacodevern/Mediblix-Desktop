import repositories from "../../database/repositories/index.js";
import { getTenantContext } from "../utils/tenantHelper.js";

const { productRepository, importHistoryRepository } = repositories;

const getProducts = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const products = productRepository.findAll(orgId);
    res.json(products);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getProductById = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const product = productRepository.findById(req.params.id, orgId);
    if (product) {
      res.json(product);
    } else {
      res.status(404).json({ message: "Product not found" });
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const searchProducts = async (req, res) => {
  const { q } = req.query;
  try {
    const orgId = await getTenantContext(req);
    const products = productRepository.search(q, orgId);
    res.json(products);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const createProduct = async (req, res) => {
  const {
    name,
    sku,
    category,
    price,
    quantity,
    status,
    expiryDate,
    mfgDate,
    hsn,
    packaging,
    tabletsPerStrip,
  } = req.body;

  try {
    const orgId = await getTenantContext(req);
    const cleanSku = String(sku || "").trim();

    if (!cleanSku || !name) {
      return res.status(400).json({ message: "Product name and SKU are required" });
    }

    const productExists = productRepository.findBySku(cleanSku, orgId);
    if (productExists) {
      return res.status(400).json({ message: "Product already exists with this SKU in this organization" });
    }

    const product = productRepository.create({
      organization: orgId,
      name,
      sku: cleanSku,
      category: category || "General",
      price: Number(price) || 0,
      quantity: Number(quantity) || 0,
      status,
      expiryDate,
      mfgDate,
      hsn,
      packaging,
      tabletsPerStrip,
    });

    if (product) {
      const qty = Number(quantity) || 0;
      const unitPrice = Number(price) || 0;

      importHistoryRepository.create({
        organization: orgId,
        fileName: "Manual Entry",
        totalProducts: 1,
        totalQuantity: qty,
        totalValue: qty * unitPrice,
        items: [
          {
            name: product.name,
            sku: product.sku,
            category: product.category,
            quantity: qty,
            price: unitPrice,
            status: "New",
          },
        ],
      });

      res.status(201).json(product);
    } else {
      res.status(400).json({ message: "Invalid product data" });
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const updateProduct = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const existing = productRepository.findById(req.params.id, orgId);

    if (!existing) {
      return res.status(404).json({ message: "Product not found" });
    }

    if (req.body.sku && req.body.sku !== existing.sku) {
      const duplicateSku = productRepository.findBySku(req.body.sku, orgId);
      if (duplicateSku && duplicateSku._id !== existing._id) {
        return res.status(400).json({ message: "Another product with this SKU already exists" });
      }
    }

    const updatedProduct = productRepository.update(req.params.id, req.body);
    res.json(updatedProduct);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const deleteProduct = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const existing = productRepository.findById(req.params.id, orgId);

    if (!existing) {
      return res.status(404).json({ message: "Product not found" });
    }

    productRepository.delete(req.params.id);
    res.json({ message: "Product removed" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

export {
  getProducts,
  getProductById,
  searchProducts,
  createProduct,
  updateProduct,
  deleteProduct,
};
