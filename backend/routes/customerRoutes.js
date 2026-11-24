import express from "express";
import {
  getCustomers,
  createCustomer,
  searchCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
} from "../controllers/customerController.js";
import { protect } from "../utils/authMiddleware.js";

const router = express.Router();

// Enforce authentication on all customer operations
router.use(protect);

router.route("/").get(getCustomers).post(createCustomer);
router.route("/search").get(searchCustomers);
router
  .route("/:id")
  .get(getCustomerById)
  .put(updateCustomer)
  .delete(deleteCustomer);

export default router;
