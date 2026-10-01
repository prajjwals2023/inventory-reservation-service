const reservationService = require('../services/reservationService');

class ReservationController {
  async reserve(req, res, next) {
    try {
      const productId = req.params.productId || req.body.productId;
      const { quantity } = req.body;
      const idempotencyKey =
        req.headers['idempotency-key'] ||
        req.headers['idempotency_key'] ||
        req.body.idempotencyKey;

      const result = await reservationService.reserve({
        productId,
        quantity: Number(quantity),
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
      });

      if (result.isIdempotentReplay) {
        res.setHeader('X-Cache-Lookup', 'HIT');
        return res.status(200).json(result.data);
      }

      return res.status(201).json(result.data);
    } catch (err) {
      next(err);
    }
  }

  async confirm(req, res, next) {
    try {
      const { id } = req.params;
      const updated = await reservationService.confirmReservation(id);
      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  }

  async release(req, res, next) {
    try {
      const { id } = req.params;
      const updated = await reservationService.releaseReservation(id);
      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const reservation = await reservationService.getReservationById(id);
      return res.status(200).json(reservation);
    } catch (err) {
      next(err);
    }
  }

  async cleanupExpired(req, res, next) {
    try {
      const configuredKey = process.env.ADMIN_API_KEY;
      if (configuredKey && process.env.NODE_ENV !== 'test') {
        const providedKey =
          req.headers['x-admin-key'] ||
          (req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : null);

        if (providedKey !== configuredKey) {
          return res.status(401).json({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Invalid or missing admin key for cleanup endpoint',
            },
          });
        }
      }

      const result = await reservationService.expireOverdueReservations();
      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ReservationController();
