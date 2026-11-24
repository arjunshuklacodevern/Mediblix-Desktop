import repositories from "../../database/repositories/index.js";
import { getTenantContext } from "../utils/tenantHelper.js";

const { purchaseOrderRepository } = repositories;

const getPurchaseOrders = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const orders = purchaseOrderRepository.findAll(orgId);
    res.json(orders);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getPurchaseOrderById = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const order = purchaseOrderRepository.findById(req.params.id, orgId);
    if (!order) {
      return res.status(404).json({ message: "Purchase order not found" });
    }
    res.json(order);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const createPurchaseOrder = async (req, res) => {
  const {
    supplierName,
    supplierEmail,
    supplierPhone,
    deliveryAddress,
    items,
    expectedDeliveryDate,
  } = req.body;

  if (!supplierName || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Supplier name and non-empty items array are required" });
  }

  for (const item of items) {
    if (!item.productName || !item.sku) {
      return res.status(400).json({ message: "Each item must have productName and sku" });
    }
    if (Number(item.quantity) <= 0) {
      return res.status(400).json({ message: "Item quantity must be greater than 0" });
    }
  }

  try {
    const orgId = await getTenantContext(req);

    const order = purchaseOrderRepository.create({
      organization: orgId,
      supplierName: String(supplierName).trim(),
      supplierEmail: supplierEmail || null,
      supplierPhone: supplierPhone || null,
      deliveryAddress: deliveryAddress || null,
      items,
      expectedDeliveryDate: expectedDeliveryDate || null,
      status: "Pending",
    });

    res.status(201).json(order);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const updatePurchaseOrderStatus = async (req, res) => {
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ message: "Status is required" });
  }

  try {
    const orgId = await getTenantContext(req);
    const updatedOrder = purchaseOrderRepository.updateStatus(req.params.id, status, orgId);
    res.json(updatedOrder);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const deletePurchaseOrder = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const order = purchaseOrderRepository.findById(req.params.id, orgId);
    if (!order) {
      return res.status(404).json({ message: "Purchase order not found" });
    }

    purchaseOrderRepository.delete(req.params.id, orgId);
    res.json({ message: "Purchase order deleted successfully" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

export {
  getPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  updatePurchaseOrderStatus,
  deletePurchaseOrder,
};
