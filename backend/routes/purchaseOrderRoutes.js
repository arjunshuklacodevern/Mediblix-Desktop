import express from "express";
import {
  getPurchaseOrders,
  createPurchaseOrder,
  deletePurchaseOrder,
  updatePurchaseOrderStatus,
  getPurchaseOrderById,
} from "../controllers/purchaseOrderController.js";
import { protect } from "../utils/authMiddleware.js";

const router = express.Router();

// Enforce authentication on all purchase order operations
router.use(protect);

router.route("/").get(getPurchaseOrders).post(createPurchaseOrder);
router.route("/:id").get(getPurchaseOrderById).delete(deletePurchaseOrder);
router.route("/:id/status").patch(updatePurchaseOrderStatus);

export default router;
