const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/database');

describe('Product and Inventory API Tests', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.idempotencyRecord.deleteMany({});
    await prisma.reservation.deleteMany({});
    await prisma.inventory.deleteMany({});
    await prisma.product.deleteMany({});
  });

  test('POST /products - should successfully create product with initial stock', async () => {
    const res = await request(app)
      .post('/products')
      .send({
        sku: 'KB-RGB-001',
        name: 'Gaming Keyboard',
        description: 'RGB Mechanical Gaming Keyboard',
        price: 89.99,
        initialStock: 25,
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.sku).toBe('KB-RGB-001');
    expect(res.body.inventory.totalQuantity).toBe(25);
    expect(res.body.inventory.availableQuantity).toBe(25);
    expect(res.body.inventory.reservedQuantity).toBe(0);
  });

  test('POST /products - should reject duplicate SKU', async () => {
    await request(app)
      .post('/products')
      .send({
        sku: 'DUP-SKU-1',
        name: 'First Item',
        price: 10,
        initialStock: 5,
      });

    const duplicateRes = await request(app)
      .post('/products')
      .send({
        sku: 'DUP-SKU-1',
        name: 'Second Item',
        price: 15,
        initialStock: 5,
      });

    expect(duplicateRes.status).toBe(400);
    expect(duplicateRes.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('GET /products/:id - should retrieve product details and inventory', async () => {
    const createRes = await request(app)
      .post('/products')
      .send({
        sku: 'MOUSE-01',
        name: 'Wireless Mouse',
        price: 29.99,
        initialStock: 50,
      });

    const productId = createRes.body.id;

    const res = await request(app).get(`/products/${productId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(productId);
    expect(res.body.inventory.totalQuantity).toBe(50);
  });

  test('PUT /products/:id - should update product details', async () => {
    const createRes = await request(app)
      .post('/products')
      .send({
        sku: 'HEADSET-UPDATE',
        name: 'Old Headset Name',
        description: 'Old Description',
        price: 49.99,
        initialStock: 20,
      });

    const productId = createRes.body.id;

    const updateRes = await request(app)
      .put(`/products/${productId}`)
      .send({
        name: 'New Headset Pro',
        description: 'New Noise Cancelling Headset',
        price: 69.99,
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.name).toBe('New Headset Pro');
    expect(updateRes.body.description).toBe('New Noise Cancelling Headset');
    expect(Number(updateRes.body.price)).toBe(69.99);
  });

  test('DELETE /products/:id - should delete product and associated inventory', async () => {
    const createRes = await request(app)
      .post('/products')
      .send({
        sku: 'TO-DELETE',
        name: 'Temporary Item',
        price: 9.99,
        initialStock: 5,
      });

    const productId = createRes.body.id;

    const deleteRes = await request(app).delete(`/products/${productId}`);
    expect(deleteRes.status).toBe(200);

    const getRes = await request(app).get(`/products/${productId}`);
    expect(getRes.status).toBe(404);
  });

  test('GET /inventory/:productId - should view current inventory breakdown', async () => {
    const createRes = await request(app)
      .post('/products')
      .send({
        sku: 'MONITOR-4K',
        name: '4K Gaming Monitor',
        price: 399.99,
        initialStock: 12,
      });

    const productId = createRes.body.id;

    const res = await request(app).get(`/inventory/${productId}`);
    expect(res.status).toBe(200);
    expect(res.body.productId).toBe(productId);
    expect(res.body.totalQuantity).toBe(12);
    expect(res.body.availableQuantity).toBe(12);
    expect(res.body.reservedQuantity).toBe(0);
  });

  test('POST /inventory/:productId/restock - should increase total and available inventory', async () => {
    const createRes = await request(app)
      .post('/products')
      .send({
        sku: 'HEADSET-01',
        name: 'Studio Headset',
        price: 79.99,
        initialStock: 10,
      });

    const productId = createRes.body.id;

    const restockRes = await request(app)
      .post(`/inventory/${productId}/restock`)
      .send({ quantity: 15 });

    expect(restockRes.status).toBe(200);
    expect(restockRes.body.totalQuantity).toBe(25);
    expect(restockRes.body.availableQuantity).toBe(25);
    expect(restockRes.body.reservedQuantity).toBe(0);
  });
});
