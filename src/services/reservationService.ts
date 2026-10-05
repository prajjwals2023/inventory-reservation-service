import crypto from 'crypto';
import prisma from '../config/database';
import {
  NotFoundError,
  InsufficientInventoryError,
  InvalidStateError,
  IdempotencyConflictError,
  ValidationError,
} from '../middleware/errorHandler';
import { ReservationStatus } from '../models/reservation';
import { Reservation, Prisma } from '@prisma/client';

export interface ReserveInput {
  productId: string;
  quantity: number;
  idempotencyKey?: string | null;
}

export interface ReserveResult {
  data: Reservation;
  isIdempotentReplay: boolean;
}

interface ExecuteReservationParams {
  productId: string;
  quantity: number;
  trimmedKey: string | null;
  requestHash: string | null;
  expiresAt: Date;
}

class ReservationService {
  async reserve({ productId, quantity, idempotencyKey }: ReserveInput): Promise<ReserveResult> {
    if (!productId || typeof productId !== 'string') {
      throw new ValidationError('Product ID is required');
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('Quantity must be a positive integer');
    }

    const trimmedKey = idempotencyKey ? idempotencyKey.trim() : null;
    let requestHash: string | null = null;

    // Fast-path idempotency check before acquiring database locks
    if (trimmedKey) {
      requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ productId, quantity }))
        .digest('hex');

      const existingRecord = await prisma.idempotencyRecord.findUnique({
        where: { key: trimmedKey },
      });

      if (existingRecord) {
        if (existingRecord.requestHash === requestHash) {
          const cachedResponse = JSON.parse(existingRecord.responseBody);
          return { data: cachedResponse, isIdempotentReplay: true };
        } else {
          throw new IdempotencyConflictError(
            'Idempotency key was already used with different request parameters'
          );
        }
      }
    }

    const ttlMinutes = parseInt(process.env.RESERVATION_TTL_MINUTES || '15', 10);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    try {
      return await this._executeReservationTransaction({
        productId,
        quantity,
        trimmedKey,
        requestHash,
        expiresAt,
      });
    } catch (err: unknown) {
      // Handle race condition where two concurrent requests with the exact same
      // idempotency key both passed the initial lookup and hit a unique constraint (P2002)
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002' && trimmedKey) {
        const existingRecord = await prisma.idempotencyRecord.findUnique({
          where: { key: trimmedKey },
        });

        if (existingRecord) {
          if (existingRecord.requestHash === requestHash) {
            const cachedResponse = JSON.parse(existingRecord.responseBody);
            return { data: cachedResponse, isIdempotentReplay: true };
          } else {
            throw new IdempotencyConflictError(
              'Idempotency key was already used with different request parameters'
            );
          }
        }
      }
      throw err;
    }
  }

  async _executeReservationTransaction({
    productId,
    quantity,
    trimmedKey,
    requestHash,
    expiresAt,
  }: ExecuteReservationParams): Promise<ReserveResult> {
    return await prisma.$transaction(async (tx) => {
      // 1. Pessimistic row lock on product inventory
      const [lockedRow] = await tx.$queryRaw<Array<{ id: string; productId: string }>>`
        SELECT * FROM "inventories" WHERE "productId" = ${productId} FOR UPDATE
      `;

      if (!lockedRow) {
        throw new NotFoundError(`Product with ID '${productId}' does not exist or has no inventory`);
      }

      // 2. Proactively expire any overdue reservations for THIS product inside the transaction
      // so expired stock is immediately recycled before checking availableQuantity
      const now = new Date();
      const overdueReservations = await tx.reservation.findMany({
        where: {
          productId,
          status: ReservationStatus.PENDING,
          expiresAt: { lte: now },
        },
      });

      for (const overdue of overdueReservations) {
        const expUpdate = await tx.reservation.updateMany({
          where: { id: overdue.id, status: ReservationStatus.PENDING },
          data: { status: ReservationStatus.EXPIRED },
        });

        if (expUpdate.count > 0) {
          await tx.inventory.update({
            where: { productId },
            data: {
              availableQuantity: { increment: overdue.quantity },
              reservedQuantity: { decrement: overdue.quantity },
            },
          });
        }
      }

      // Re-read inventory after expired reservations have restored their stock
      const inventory = await tx.inventory.findUnique({
        where: { productId },
      });

      if (!inventory || inventory.availableQuantity < quantity) {
        throw new InsufficientInventoryError(
          `Insufficient inventory. Requested: ${quantity}, Available: ${inventory?.availableQuantity ?? 0}`
        );
      }

      // 3. Atomically decrement available and increment reserved
      await tx.inventory.update({
        where: { productId },
        data: {
          availableQuantity: { decrement: quantity },
          reservedQuantity: { increment: quantity },
        },
      });

      // 4. Create reservation
      const reservation = await tx.reservation.create({
        data: {
          productId,
          quantity,
          status: ReservationStatus.PENDING,
          idempotencyKey: trimmedKey,
          expiresAt,
        },
      });

      // 5. Persist idempotency record in the same transaction
      if (trimmedKey) {
        await tx.idempotencyRecord.create({
          data: {
            key: trimmedKey,
            requestPath: `/inventory/${productId}/reserve`,
            requestMethod: 'POST',
            requestHash: requestHash!,
            statusCode: 201,
            responseBody: JSON.stringify(reservation),
          },
        });
      }

      return { data: reservation, isIdempotentReplay: false };
    });
  }

  async confirmReservation(reservationId: string): Promise<Reservation | null> {
    if (!reservationId) {
      throw new ValidationError('Reservation ID is required');
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Fetch reservation to identify product and quantity
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });

      if (!reservation) {
        throw new NotFoundError(`Reservation with ID '${reservationId}' not found`);
      }

      // 2. Lock inventory row for this product first
      await tx.$queryRaw`
        SELECT * FROM "inventories" WHERE "productId" = ${reservation.productId} FOR UPDATE
      `;

      // 3. Conditional status update: must be PENDING and expiresAt > now
      const now = new Date();
      const updateResult = await tx.reservation.updateMany({
        where: {
          id: reservationId,
          status: ReservationStatus.PENDING,
          expiresAt: { gt: now },
        },
        data: {
          status: ReservationStatus.CONFIRMED,
          confirmedAt: now,
        },
      });

      if (updateResult.count === 0) {
        // Find current state to report accurate error and handle expired inline
        const current = await tx.reservation.findUnique({ where: { id: reservationId } });
        if (!current) {
          throw new NotFoundError(`Reservation with ID '${reservationId}' not found`);
        }
        if (current.status === ReservationStatus.PENDING && current.expiresAt <= now) {
          // Atomically expire and return stock to available
          await tx.reservation.updateMany({
            where: { id: reservationId, status: ReservationStatus.PENDING },
            data: { status: ReservationStatus.EXPIRED },
          });
          await tx.inventory.update({
            where: { productId: current.productId },
            data: {
              availableQuantity: { increment: current.quantity },
              reservedQuantity: { decrement: current.quantity },
            },
          });
          throw new InvalidStateError('Reservation has expired and cannot be confirmed');
        }
        throw new InvalidStateError(
          `Cannot confirm reservation in '${current.status}' state. Only PENDING reservations can be confirmed.`
        );
      }

      // 4. ONLY adjust inventory after successfully winning the conditional update!
      await tx.inventory.update({
        where: { productId: reservation.productId },
        data: {
          totalQuantity: { decrement: reservation.quantity },
          reservedQuantity: { decrement: reservation.quantity },
        },
      });

      return await tx.reservation.findUnique({ where: { id: reservationId } });
    });
  }

  async releaseReservation(reservationId: string): Promise<Reservation | null> {
    if (!reservationId) {
      throw new ValidationError('Reservation ID is required');
    }

    return await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });

      if (!reservation) {
        throw new NotFoundError(`Reservation with ID '${reservationId}' not found`);
      }

      // 1. Lock inventory row for this product first
      await tx.$queryRaw`
        SELECT * FROM "inventories" WHERE "productId" = ${reservation.productId} FOR UPDATE
      `;

      const now = new Date();

      // Check if already expired
      if (reservation.status === ReservationStatus.PENDING && reservation.expiresAt <= now) {
        await tx.reservation.updateMany({
          where: { id: reservationId, status: ReservationStatus.PENDING },
          data: { status: ReservationStatus.EXPIRED },
        });
        await tx.inventory.update({
          where: { productId: reservation.productId },
          data: {
            availableQuantity: { increment: reservation.quantity },
            reservedQuantity: { decrement: reservation.quantity },
          },
        });
        throw new InvalidStateError('Reservation has expired and cannot be released');
      }

      // 2. Conditional status update: must be PENDING
      const updateResult = await tx.reservation.updateMany({
        where: {
          id: reservationId,
          status: ReservationStatus.PENDING,
        },
        data: {
          status: ReservationStatus.RELEASED,
          releasedAt: now,
        },
      });

      if (updateResult.count === 0) {
        const current = await tx.reservation.findUnique({ where: { id: reservationId } });
        const currentStatus = current ? current.status : 'UNKNOWN';
        throw new InvalidStateError(
          `Cannot release reservation in '${currentStatus}' state. Only PENDING reservations can be released.`
        );
      }

      // 3. ONLY restore inventory after successfully winning the conditional update!
      await tx.inventory.update({
        where: { productId: reservation.productId },
        data: {
          availableQuantity: { increment: reservation.quantity },
          reservedQuantity: { decrement: reservation.quantity },
        },
      });

      return await tx.reservation.findUnique({ where: { id: reservationId } });
    });
  }

  async getReservationById(reservationId: string) {
    if (!reservationId) {
      throw new ValidationError('Reservation ID is required');
    }

    let reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            price: true,
          },
        },
      },
    });

    if (!reservation) {
      throw new NotFoundError(`Reservation with ID '${reservationId}' not found`);
    }

    // Lazy check: if expired, atomically update and restore stock
    if (reservation.status === ReservationStatus.PENDING && reservation.expiresAt <= new Date()) {
      await this.expireSingleReservation(reservation);
      reservation = await prisma.reservation.findUnique({
        where: { id: reservationId },
        include: {
          product: {
            select: {
              id: true,
              sku: true,
              name: true,
              price: true,
            },
          },
        },
      });
    }

    return reservation;
  }

  async expireSingleReservation(reservation: { id: string; productId: string; quantity: number }): Promise<void> {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT * FROM "inventories" WHERE "productId" = ${reservation.productId} FOR UPDATE
        `;

        const updated = await tx.reservation.updateMany({
          where: {
            id: reservation.id,
            status: ReservationStatus.PENDING,
          },
          data: {
            status: ReservationStatus.EXPIRED,
          },
        });

        if (updated.count > 0) {
          await tx.inventory.update({
            where: { productId: reservation.productId },
            data: {
              availableQuantity: { increment: reservation.quantity },
              reservedQuantity: { decrement: reservation.quantity },
            },
          });
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ReservationService] Failed to expire reservation ${reservation.id}:`, msg);
    }
  }

  async expireOverdueReservations(): Promise<{ expiredCount: number }> {
    const now = new Date();
    const overdue = await prisma.reservation.findMany({
      where: {
        status: ReservationStatus.PENDING,
        expiresAt: { lte: now },
      },
      take: 100,
    });

    let expiredCount = 0;
    for (const res of overdue) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT * FROM "inventories" WHERE "productId" = ${res.productId} FOR UPDATE
          `;

          const updateResult = await tx.reservation.updateMany({
            where: {
              id: res.id,
              status: ReservationStatus.PENDING,
            },
            data: {
              status: ReservationStatus.EXPIRED,
            },
          });

          if (updateResult.count > 0) {
            await tx.inventory.update({
              where: { productId: res.productId },
              data: {
                availableQuantity: { increment: res.quantity },
                reservedQuantity: { decrement: res.quantity },
              },
            });
            expiredCount++;
          }
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ReservationService] Error expiring reservation ${res.id}:`, msg);
      }
    }

    return { expiredCount };
  }
}

export default new ReservationService();
