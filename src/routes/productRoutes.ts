import { Router } from 'express';
import productController from '../controllers/productController';
import inventoryController from '../controllers/inventoryController';
import reservationController from '../controllers/reservationController';

const router = Router();

router.post('/', (req, res, next) => productController.createProduct(req, res, next));
router.get('/', (req, res, next) => productController.getAllProducts(req, res, next));
router.get('/:id', (req, res, next) => productController.getProductById(req, res, next));
router.put('/:id', (req, res, next) => productController.updateProduct(req, res, next));
router.delete('/:id', (req, res, next) => productController.deleteProduct(req, res, next));

// Nested inventory endpoints on products
router.get('/:id/inventory', (req, res, next) => inventoryController.getInventory(req, res, next));
router.post('/:id/inventory/restock', (req, res, next) => inventoryController.restockInventory(req, res, next));
router.post('/:productId/reserve', (req, res, next) => reservationController.reserve(req, res, next));

export default router;
