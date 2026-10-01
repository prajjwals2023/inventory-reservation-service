function validateProductInput({ sku, name, price, initialStock }) {
  const errors = [];

  if (!sku || typeof sku !== 'string' || sku.trim().length === 0) {
    errors.push('SKU is required and must be a non-empty string');
  }

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    errors.push('Name is required and must be a non-empty string');
  }

  if (price === undefined || typeof price !== 'number' || price < 0) {
    errors.push('Price is required and must be a non-negative number');
  }

  if (initialStock !== undefined && (!Number.isInteger(initialStock) || initialStock < 0)) {
    errors.push('Initial stock must be a non-negative integer');
  }

  return errors;
}

module.exports = {
  validateProductInput,
};
