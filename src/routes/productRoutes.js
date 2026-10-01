const express = require('express');
const productController = require('../controllers/productController');
const inventoryController = require('../controllers/inventoryController');
const reservationController = require('../controllers/reservationController');

const router = express.Router();

router.post('/', productController.createProduct);
router.get('/', productController.getAllProducts);
router.get('/:id', productController.getProductById);
router.put('/:id', productController.updateProduct);
router.delete('/:id', productController.deleteProduct);

// Nested inventory endpoints on products
router.get('/:id/inventory', inventoryController.getInventory);
router.post('/:id/inventory/restock', inventoryController.restockInventory);
router.post('/:productId/reserve', reservationController.reserve);

module.exports = router;
