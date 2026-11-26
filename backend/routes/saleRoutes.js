import express from "express";
import {
  createSale,
  getSales,
  generateInvoice,
  processReturn,
  modifyInvoice,
} from "../controllers/saleController.js";
import { protect } from "../utils/authMiddleware.js";

const router = express.Router();

// Enforce authentication on all sales & POS operations
router.use(protect);

router.route("/").post(createSale).get(getSales);
router.route("/:id/invoice").get(generateInvoice);
router.route("/:id/return").post(processReturn);
router.route("/:id/modify").put(modifyInvoice);

export default router;
