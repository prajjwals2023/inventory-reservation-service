import { Router } from 'express';
import reservationController from '../controllers/reservationController';

const router = Router();

router.post('/', (req, res, next) => reservationController.reserve(req, res, next));
router.get('/:id', (req, res, next) => reservationController.getById(req, res, next));
router.post('/:id/confirm', (req, res, next) => reservationController.confirm(req, res, next));
router.post('/:id/release', (req, res, next) => reservationController.release(req, res, next));
router.post('/cleanup-expired', (req, res, next) => reservationController.cleanupExpired(req, res, next));

export default router;
