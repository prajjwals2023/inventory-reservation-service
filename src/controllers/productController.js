const productService = require('../services/productService');

class ProductController {
  async createProduct(req, res, next) {
    try {
      const { sku, name, description, price, initialStock } = req.body;
      const product = await productService.createProduct({
        sku,
        name,
        description,
        price,
        initialStock,
      });
      return res.status(201).json(product);
    } catch (err) {
      next(err);
    }
  }

  async getAllProducts(req, res, next) {
    try {
      const products = await productService.getAllProducts();
      return res.status(200).json(products);
    } catch (err) {
      next(err);
    }
  }

  async getProductById(req, res, next) {
    try {
      const product = await productService.getProductById(req.params.id);
      return res.status(200).json(product);
    } catch (err) {
      next(err);
    }
  }

  async updateProduct(req, res, next) {
    try {
      const { name, description, price } = req.body;
      const updated = await productService.updateProduct(req.params.id, {
        name,
        description,
        price,
      });
      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  }

  async deleteProduct(req, res, next) {
    try {
      const result = await productService.deleteProduct(req.params.id);
      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ProductController();
