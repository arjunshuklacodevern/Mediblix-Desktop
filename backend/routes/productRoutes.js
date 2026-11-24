import express from "express";
import {
  getProducts,
  getProductById,
  searchProducts,
  createProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/productController.js";
import { protect } from "../utils/authMiddleware.js";

const router = express.Router();

// Enforce authentication on product operations
router.use(protect);

router.route("/").get(getProducts).post(createProduct);
router.route("/search").get(searchProducts);
router
  .route("/:id")
  .get(getProductById)
  .put(updateProduct)
  .delete(deleteProduct);

export default router;
