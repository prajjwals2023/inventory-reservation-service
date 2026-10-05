const swaggerDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Inventory Reservation Service API',
    version: '1.0.0',
    description:
      'Backend service for an e-commerce platform managing product inventory, temporary reservations, race-condition prevention, and idempotency.',
  },
  servers: [
    {
      url: '/',
      description: 'Current Environment Server',
    },
  ],
  paths: {
    '/health': {
      get: {
        summary: 'Health Check',
        responses: {
          200: {
            description: 'Service is operational',
          },
        },
      },
    },
    '/products': {
      post: {
        summary: 'Create a new product with initial inventory',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sku', 'name', 'price'],
                properties: {
                  sku: { type: 'string', example: 'PROD-101' },
                  name: { type: 'string', example: 'Mechanical Keyboard' },
                  description: { type: 'string', example: 'Wireless RGB mechanical keyboard' },
                  price: { type: 'number', example: 99.99 },
                  initialStock: { type: 'integer', example: 10 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Product created successfully' },
          400: { description: 'Validation error' },
        },
      },
      get: {
        summary: 'List all products with their inventory',
        responses: {
          200: { description: 'List of products' },
        },
      },
    },
    '/products/{id}': {
      get: {
        summary: 'Get product by ID',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Product details' },
          404: { description: 'Product not found' },
        },
      },
      put: {
        summary: 'Update product details (name, description, price)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'Updated Mechanical Keyboard' },
                  description: { type: 'string', example: 'Updated description' },
                  price: { type: 'number', example: 109.99 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Product updated successfully' },
          400: { description: 'Validation error' },
          404: { description: 'Product not found' },
        },
      },
      delete: {
        summary: 'Delete product by ID',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Product deleted successfully' },
          404: { description: 'Product not found' },
        },
      },
    },
    '/inventory/{productId}': {
      get: {
        summary: 'View current inventory for a product',
        parameters: [
          { name: 'productId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'Inventory levels breakdown (total, available, reserved)',
          },
          404: { description: 'Inventory not found' },
        },
      },
    },
    '/inventory/{productId}/restock': {
      post: {
        summary: 'Restock inventory for a product',
        parameters: [
          { name: 'productId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['quantity'],
                properties: {
                  quantity: { type: 'integer', example: 25 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Inventory restocked' },
          400: { description: 'Invalid quantity' },
          404: { description: 'Product not found' },
        },
      },
    },
    '/inventory/{productId}/reserve': {
      post: {
        summary: 'Reserve inventory for a product (supports Idempotency-Key)',
        parameters: [
          { name: 'productId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string', example: '7f83-abc-123' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['quantity'],
                properties: {
                  quantity: { type: 'integer', example: 7 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Reservation created successfully' },
          200: { description: 'Idempotent request replay' },
          409: { description: 'Insufficient inventory available' },
          422: { description: 'Idempotency key reuse with different parameters' },
        },
      },
    },
    '/reservations': {
      post: {
        summary: 'Create a reservation by supplying productId and quantity in body',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string', example: '7f83-abc-123' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['productId', 'quantity'],
                properties: {
                  productId: { type: 'string' },
                  quantity: { type: 'integer', example: 5 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Reservation created' },
          409: { description: 'Insufficient inventory' },
        },
      },
    },
    '/reservations/{id}': {
      get: {
        summary: 'View reservation details',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Reservation details' },
          404: { description: 'Reservation not found' },
        },
      },
    },
    '/reservations/{id}/confirm': {
      post: {
        summary: 'Confirm a reservation when an order is finalized',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Reservation confirmed; inventory permanently committed' },
          404: { description: 'Reservation not found' },
          409: { description: 'Invalid state (e.g. already confirmed, released, or expired)' },
        },
      },
    },
    '/reservations/{id}/release': {
      post: {
        summary: 'Release a reservation and restore inventory to available',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Reservation released; inventory restored' },
          404: { description: 'Reservation not found' },
          409: { description: 'Invalid state (e.g. already confirmed, released, or expired)' },
        },
      },
    },
    '/reservations/cleanup-expired': {
      post: {
        summary: 'Trigger manual cleanup of expired reservations (Requires X-Admin-Key if configured)',
        parameters: [
          {
            name: 'X-Admin-Key',
            in: 'header',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: { description: 'Expired reservations processed and inventory restored' },
          401: { description: 'Unauthorized' },
        },
      },
    },
  },
};

export default swaggerDocument;
