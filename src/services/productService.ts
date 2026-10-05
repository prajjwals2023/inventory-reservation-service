import prisma from '../config/database';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';
import { validateProductInput, ProductInput } from '../models/product';
import { Prisma } from '@prisma/client';

export interface InventorySummary {
  totalQuantity: number;
  availableQuantity: number;
  reservedQuantity: number;
}

export interface ProductWithInventory {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  price: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
  inventory: InventorySummary;
}

class ProductService {
  async createProduct(input: ProductInput): Promise<ProductWithInventory> {
    const validationErrors = validateProductInput(input);
    if (validationErrors.length > 0) {
      throw new ValidationError('Invalid product input', validationErrors);
    }

    const existing = await prisma.product.findUnique({
      where: { sku: input.sku.trim() },
    });
    if (existing) {
      throw new ValidationError(`Product with SKU '${input.sku}' already exists`);
    }

    return await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          sku: input.sku.trim(),
          name: input.name.trim(),
          description: input.description ? input.description.trim() : null,
          price: input.price,
        },
      });

      const inventory = await tx.inventory.create({
        data: {
          productId: product.id,
          totalQuantity: input.initialStock ?? 0,
          availableQuantity: input.initialStock ?? 0,
          reservedQuantity: 0,
        },
      });

      return {
        ...product,
        inventory: {
          totalQuantity: inventory.totalQuantity,
          availableQuantity: inventory.availableQuantity,
          reservedQuantity: inventory.reservedQuantity,
        },
      };
    });
  }

  async getAllProducts() {
    return await prisma.product.findMany({
      include: {
        inventory: {
          select: {
            totalQuantity: true,
            availableQuantity: true,
            reservedQuantity: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getProductById(id: string) {
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        inventory: {
          select: {
            totalQuantity: true,
            availableQuantity: true,
            reservedQuantity: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundError(`Product with ID '${id}' not found`);
    }

    return product;
  }

  async updateProduct(
    id: string,
    updates: { name?: string; description?: string | null; price?: number }
  ) {
    await this.getProductById(id);

    const updateData: Prisma.ProductUpdateInput = {};

    if (updates.name !== undefined) {
      if (typeof updates.name !== 'string' || updates.name.trim().length === 0) {
        throw new ValidationError('Name must be a non-empty string');
      }
      updateData.name = updates.name.trim();
    }

    if (updates.description !== undefined) {
      updateData.description = updates.description ? updates.description.trim() : null;
    }

    if (updates.price !== undefined) {
      if (typeof updates.price !== 'number' || updates.price < 0) {
        throw new ValidationError('Price must be a non-negative number');
      }
      updateData.price = updates.price;
    }

    return await prisma.product.update({
      where: { id },
      data: updateData,
      include: {
        inventory: {
          select: {
            totalQuantity: true,
            availableQuantity: true,
            reservedQuantity: true,
            updatedAt: true,
          },
        },
      },
    });
  }

  async deleteProduct(id: string): Promise<{ message: string }> {
    await this.getProductById(id);

    await prisma.product.delete({ where: { id } });

    return { message: `Product with ID '${id}' successfully deleted` };
  }
}

export default new ProductService();
