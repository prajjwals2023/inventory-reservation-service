const express = require('express');
const inventoryController = require('../controllers/inventoryController');
const reservationController = require('../controllers/reservationController');

const router = express.Router();

router.get('/:productId', inventoryController.getInventory);
router.post('/:productId/restock', inventoryController.restockInventory);
router.post('/:productId/reserve', reservationController.reserve);

module.exports = router;
