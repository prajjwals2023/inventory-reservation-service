export interface ProductInput {
  sku: string;
  name: string;
  description?: string | null;
  price: number;
  initialStock?: number;
}

export function validateProductInput(input: ProductInput): string[] {
  const errors: string[] = [];

  if (!input.sku || typeof input.sku !== 'string' || input.sku.trim().length === 0) {
    errors.push('SKU is required and must be a non-empty string');
  }

  if (!input.name || typeof input.name !== 'string' || input.name.trim().length === 0) {
    errors.push('Name is required and must be a non-empty string');
  }

  if (typeof input.price !== 'number' || input.price < 0) {
    errors.push('Price must be a non-negative number');
  }

  const stock = input.initialStock ?? 0;
  if (!Number.isInteger(stock) || stock < 0) {
    errors.push('Initial stock must be a non-negative integer');
  }

  return errors;
}
