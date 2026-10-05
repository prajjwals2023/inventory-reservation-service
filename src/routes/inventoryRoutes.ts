import { Router } from 'express';
import inventoryController from '../controllers/inventoryController';
import reservationController from '../controllers/reservationController';

const router = Router();

router.get('/:productId', (req, res, next) => inventoryController.getInventory(req, res, next));
router.post('/:productId/restock', (req, res, next) => inventoryController.restockInventory(req, res, next));
router.post('/:productId/reserve', (req, res, next) => reservationController.reserve(req, res, next));

export default router;
