import { Request, Response, NextFunction } from 'express';
import productService from '../services/productService';

class ProductController {
  async createProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { sku, name, description, price, initialStock } = req.body;
      const product = await productService.createProduct({
        sku,
        name,
        description,
        price,
        initialStock,
      });
      res.status(201).json(product);
    } catch (err) {
      next(err);
    }
  }

  async getAllProducts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const products = await productService.getAllProducts();
      res.status(200).json(products);
    } catch (err) {
      next(err);
    }
  }

  async getProductById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const product = await productService.getProductById(req.params.id);
      res.status(200).json(product);
    } catch (err) {
      next(err);
    }
  }

  async updateProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, description, price } = req.body;
      const updated = await productService.updateProduct(req.params.id, {
        name,
        description,
        price,
      });
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  }

  async deleteProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await productService.deleteProduct(req.params.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

export default new ProductController();
