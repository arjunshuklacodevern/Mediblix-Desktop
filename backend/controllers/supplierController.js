import repositories from "../../database/repositories/index.js";
import { getTenantContext } from "../utils/tenantHelper.js";

const { supplierRepository } = repositories;

const getSuppliers = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const suppliers = supplierRepository.findAll(orgId);
    res.json(suppliers);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getSupplierById = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const supplier = supplierRepository.findById(req.params.id, orgId);
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }
    res.json(supplier);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const createSupplier = async (req, res) => {
  const { name, email, phone, address } = req.body;

  if (!name || !email || !phone || !address) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const orgId = await getTenantContext(req);
    const cleanName = String(name).trim();
    const exists = supplierRepository.findByName(cleanName, orgId);
    if (exists) {
      return res.status(400).json({ message: "Supplier already exists in this organization" });
    }

    const supplier = supplierRepository.create({
      organization: orgId,
      name: cleanName,
      email: String(email).trim(),
      phone: String(phone).trim(),
      address: String(address).trim(),
    });

    res.status(201).json(supplier);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const updateSupplier = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const existing = supplierRepository.findById(req.params.id, orgId);
    if (!existing) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    if (req.body.name && req.body.name.toLowerCase().trim() !== existing.name.toLowerCase().trim()) {
      const duplicate = supplierRepository.findByName(req.body.name, orgId);
      if (duplicate && duplicate._id !== existing._id) {
        return res.status(400).json({ message: "Another supplier with this name already exists" });
      }
    }

    const updated = supplierRepository.update(req.params.id, req.body, orgId);
    res.json(updated);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const deleteSupplier = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const supplier = supplierRepository.findById(req.params.id, orgId);
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    supplierRepository.delete(req.params.id, orgId);
    res.json({ message: "Supplier deleted successfully" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

export { getSuppliers, getSupplierById, createSupplier, updateSupplier, deleteSupplier };
