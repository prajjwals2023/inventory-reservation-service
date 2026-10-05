import { Request, Response, NextFunction } from 'express';
import inventoryService from '../services/inventoryService';

class InventoryController {
  async getInventory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const productId = req.params.productId || req.params.id;
      const inventory = await inventoryService.getInventory(productId);
      res.status(200).json(inventory);
    } catch (err) {
      next(err);
    }
  }

  async restockInventory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const productId = req.params.productId || req.params.id;
      const { quantity } = req.body;
      const inventory = await inventoryService.restockInventory(productId, Number(quantity));
      res.status(200).json(inventory);
    } catch (err) {
      next(err);
    }
  }
}

export default new InventoryController();
