import prisma from '../config/database';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';
import { ReservationStatus } from '../models/reservation';

export interface InventoryResponse {
  productId: string;
  productName: string;
  sku: string;
  totalQuantity: number;
  availableQuantity: number;
  reservedQuantity: number;
  updatedAt: Date;
}

export interface RestockResponse {
  productId: string;
  totalQuantity: number;
  availableQuantity: number;
  reservedQuantity: number;
  updatedAt: Date;
}

class InventoryService {
  async getInventory(productId: string): Promise<InventoryResponse> {
    if (!productId) {
      throw new ValidationError('Product ID is required');
    }

    // Lazy cleanup of any expired reservations for this product
    await this.lazyExpireReservationsForProduct(productId);

    const inventory = await prisma.inventory.findUnique({
      where: { productId },
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
          },
        },
      },
    });

    if (!inventory) {
      throw new NotFoundError(`Inventory for product ID '${productId}' not found`);
    }

    return {
      productId: inventory.productId,
      productName: inventory.product.name,
      sku: inventory.product.sku,
      totalQuantity: inventory.totalQuantity,
      availableQuantity: inventory.availableQuantity,
      reservedQuantity: inventory.reservedQuantity,
      updatedAt: inventory.updatedAt,
    };
  }

  async restockInventory(productId: string, quantity: number): Promise<RestockResponse> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('Restock quantity must be a positive integer');
    }

    return await prisma.$transaction(async (tx) => {
      // Row-level lock to ensure safe atomic updates
      const [inventory] = await tx.$queryRaw<Array<{ id: string; productId: string }>>`
        SELECT * FROM "inventories" WHERE "productId" = ${productId} FOR UPDATE
      `;

      if (!inventory) {
        throw new NotFoundError(`Inventory for product ID '${productId}' not found`);
      }

      const updated = await tx.inventory.update({
        where: { productId },
        data: {
          totalQuantity: { increment: quantity },
          availableQuantity: { increment: quantity },
        },
      });

      return {
        productId: updated.productId,
        totalQuantity: updated.totalQuantity,
        availableQuantity: updated.availableQuantity,
        reservedQuantity: updated.reservedQuantity,
        updatedAt: updated.updatedAt,
      };
    });
  }

  async lazyExpireReservationsForProduct(productId: string): Promise<void> {
    const now = new Date();
    const expiredReservations = await prisma.reservation.findMany({
      where: {
        productId,
        status: ReservationStatus.PENDING,
        expiresAt: { lte: now },
      },
    });

    if (expiredReservations.length === 0) return;

    for (const res of expiredReservations) {
      try {
        await prisma.$transaction(async (tx) => {
          // Lock inventory
          await tx.$queryRaw`
            SELECT * FROM "inventories" WHERE "productId" = ${res.productId} FOR UPDATE
          `;

          // Mark reservation EXPIRED
          const updatedRes = await tx.reservation.updateMany({
            where: {
              id: res.id,
              status: ReservationStatus.PENDING,
            },
            data: {
              status: ReservationStatus.EXPIRED,
            },
          });

          if (updatedRes.count > 0) {
            // Restore inventory
            await tx.inventory.update({
              where: { productId: res.productId },
              data: {
                availableQuantity: { increment: res.quantity },
                reservedQuantity: { decrement: res.quantity },
              },
            });
          }
        });
      } catch (err: unknown) {
        // Continue if another worker or concurrent process already expired it
      }
    }
  }
}

export default new InventoryService();
