import { Request, Response, NextFunction } from 'express';
import reservationService from '../services/reservationService';

class ReservationController {
  async reserve(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const productId = req.params.productId || req.body.productId;
      const { quantity } = req.body;
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) ||
        (req.headers['idempotency_key'] as string | undefined) ||
        req.body.idempotencyKey;

      const result = await reservationService.reserve({
        productId,
        quantity: Number(quantity),
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
      });

      if (result.isIdempotentReplay) {
        res.setHeader('X-Cache-Lookup', 'HIT');
        res.status(200).json(result.data);
        return;
      }

      res.status(201).json(result.data);
    } catch (err) {
      next(err);
    }
  }

  async confirm(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const updated = await reservationService.confirmReservation(id);
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  }

  async release(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const updated = await reservationService.releaseReservation(id);
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const reservation = await reservationService.getReservationById(id);
      res.status(200).json(reservation);
    } catch (err) {
      next(err);
    }
  }

  async cleanupExpired(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const configuredKey = process.env.ADMIN_API_KEY;
      if (configuredKey && process.env.NODE_ENV !== 'test') {
        const authHeader = req.headers['authorization'];
        const providedKey =
          (req.headers['x-admin-key'] as string | undefined) ||
          (authHeader ? authHeader.replace('Bearer ', '') : null);

        if (providedKey !== configuredKey) {
          res.status(401).json({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Invalid or missing admin key for cleanup endpoint',
            },
          });
          return;
        }
      }

      const result = await reservationService.expireOverdueReservations();
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

export default new ReservationController();
