const inventoryService = require('../services/inventoryService');

class InventoryController {
  async getInventory(req, res, next) {
    try {
      const productId = req.params.productId || req.params.id;
      const inventory = await inventoryService.getInventory(productId);
      return res.status(200).json(inventory);
    } catch (err) {
      next(err);
    }
  }

  async restockInventory(req, res, next) {
    try {
      const productId = req.params.productId || req.params.id;
      const { quantity } = req.body;
      const inventory = await inventoryService.restockInventory(productId, quantity);
      return res.status(200).json(inventory);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new InventoryController();
