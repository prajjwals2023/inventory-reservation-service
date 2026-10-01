const prisma = require('../config/database');
const { NotFoundError, ValidationError } = require('../middleware/errorHandler');

class InventoryService {
  async getInventory(productId) {
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

  async restockInventory(productId, quantity) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('Restock quantity must be a positive integer');
    }

    return await prisma.$transaction(async (tx) => {
      // Row-level lock to ensure safe atomic updates
      const [inventory] = await tx.$queryRaw`
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

  async lazyExpireReservationsForProduct(productId) {
    const now = new Date();
    const expiredReservations = await prisma.reservation.findMany({
      where: {
        productId,
        status: 'PENDING',
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
              status: 'PENDING',
            },
            data: {
              status: 'EXPIRED',
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
      } catch (err) {
        // Continue if another worker or concurrent process already expired it
      }
    }
  }
}

module.exports = new InventoryService();
