const express = require('express');
const reservationController = require('../controllers/reservationController');

const router = express.Router();

router.post('/', reservationController.reserve);
router.get('/:id', reservationController.getById);
router.post('/:id/confirm', reservationController.confirm);
router.post('/:id/release', reservationController.release);
router.post('/cleanup-expired', reservationController.cleanupExpired);

module.exports = router;
