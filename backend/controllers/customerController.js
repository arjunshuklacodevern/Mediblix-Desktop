import repositories from "../../database/repositories/index.js";
import { getTenantContext } from "../utils/tenantHelper.js";

const { customerRepository, saleRepository } = repositories;

const getCustomers = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const customers = customerRepository.findAll(orgId);
    res.json(customers);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const createCustomer = async (req, res) => {
  const { name, mobile, email, address, notes } = req.body;

  try {
    const orgId = await getTenantContext(req);

    if (!mobile || !String(mobile).trim()) {
      return res.status(400).json({ message: "Mobile number is required" });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Customer name is required" });
    }

    const cleanMobile = String(mobile).trim();
    const customerExists = customerRepository.findByMobile(cleanMobile, orgId);

    if (customerExists) {
      const updatedCustomer = customerRepository.update(
        customerExists._id,
        {
          name: name || customerExists.name,
          email: email !== undefined ? email : customerExists.email,
          address: address !== undefined ? address : customerExists.address,
          notes: notes !== undefined ? notes : customerExists.notes,
        },
        orgId
      );
      return res.status(200).json(updatedCustomer);
    }

    const customer = customerRepository.create({
      organization: orgId,
      name: String(name).trim(),
      mobile: cleanMobile,
      email: email || null,
      address: address || null,
      notes: notes || null,
    });

    if (customer) {
      res.status(201).json(customer);
    } else {
      res.status(400).json({ message: "Invalid customer data" });
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const searchCustomers = async (req, res) => {
  const { q } = req.query;
  try {
    const orgId = await getTenantContext(req);
    const customers = customerRepository.search(q, orgId);
    res.json(customers);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const getCustomerById = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const customer = customerRepository.findById(req.params.id, orgId);
    if (customer) {
      // Attach populated purchase history for customer detail page
      const sales = saleRepository.findAll({ customer: customer.id, organization: orgId });
      customer.purchaseHistory = sales;
      res.json(customer);
    } else {
      res.status(404).json({ message: "Customer not found" });
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const updateCustomer = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const existing = customerRepository.findById(req.params.id, orgId);
    if (!existing) {
      return res.status(404).json({ message: "Customer not found" });
    }

    if (req.body.mobile && req.body.mobile !== existing.mobile) {
      const duplicateMobile = customerRepository.findByMobile(req.body.mobile, orgId);
      if (duplicateMobile && duplicateMobile._id !== existing._id) {
        return res.status(400).json({ message: "Another customer with this mobile number already exists" });
      }
    }

    const updated = customerRepository.update(req.params.id, req.body, orgId);
    res.json(updated);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const orgId = await getTenantContext(req);
    const existing = customerRepository.findById(req.params.id, orgId);
    if (!existing) {
      return res.status(404).json({ message: "Customer not found" });
    }

    customerRepository.delete(req.params.id, orgId);
    res.json({ message: "Customer removed" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

export {
  getCustomers,
  createCustomer,
  searchCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
};
