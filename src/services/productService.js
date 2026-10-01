const prisma = require('../config/database');
const { NotFoundError, ValidationError } = require('../middleware/errorHandler');
const { validateProductInput } = require('../models/product');

class ProductService {
  async createProduct({ sku, name, description, price, initialStock = 0 }) {
    const validationErrors = validateProductInput({ sku, name, price, initialStock });
    if (validationErrors.length > 0) {
      throw new ValidationError('Invalid product input', validationErrors);
    }

    const existing = await prisma.product.findUnique({
      where: { sku: sku.trim() },
    });
    if (existing) {
      throw new ValidationError(`Product with SKU '${sku}' already exists`);
    }

    return await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          sku: sku.trim(),
          name: name.trim(),
          description: description ? description.trim() : null,
          price,
        },
      });

      const inventory = await tx.inventory.create({
        data: {
          productId: product.id,
          totalQuantity: initialStock,
          availableQuantity: initialStock,
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
    const products = await prisma.product.findMany({
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
    return products;
  }

  async getProductById(id) {
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

  async updateProduct(id, { name, description, price }) {
    const existing = await this.getProductById(id);

    const updateData = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new ValidationError('Name must be a non-empty string');
      }
      updateData.name = name.trim();
    }

    if (description !== undefined) {
      updateData.description = description ? description.trim() : null;
    }

    if (price !== undefined) {
      if (typeof price !== 'number' || price < 0) {
        throw new ValidationError('Price must be a non-negative number');
      }
      updateData.price = price;
    }

    const updated = await prisma.product.update({
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

    return updated;
  }

  async deleteProduct(id) {
    await this.getProductById(id);

    await prisma.product.delete({
      where: { id },
    });

    return { message: `Product with ID '${id}' successfully deleted` };
  }
}

module.exports = new ProductService();
