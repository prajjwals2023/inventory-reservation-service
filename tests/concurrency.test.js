const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/database');

describe('Concurrency, Race Condition Prevention, and Edge Cases', () => {
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

  test('Prompt Scenario: 10 units available, concurrent requests for 7 and 5 units', async () => {
    const product = await prisma.product.create({
      data: {
        sku: 'CONCURRENT-101',
        name: 'High Demand Sneaker',
        price: 150.0,
        inventory: {
          create: {
            totalQuantity: 10,
            availableQuantity: 10,
            reservedQuantity: 0,
          },
        },
      },
    });

    const productId = product.id;

    // Dispatch Request A (reserve 7) and Request B (reserve 5) concurrently
    const [resA, resB] = await Promise.all([
      request(app).post(`/inventory/${productId}/reserve`).send({ quantity: 7 }),
      request(app).post(`/inventory/${productId}/reserve`).send({ quantity: 5 }),
    ]);

    const statuses = [resA.status, resB.status].sort();

    // Exactly one must succeed with 201 Created and the other must fail with 409 Conflict
    expect(statuses).toEqual([201, 409]);

    const successRes = resA.status === 201 ? resA : resB;
    const failedRes = resA.status === 409 ? resA : resB;

    expect(failedRes.body.error.code).toBe('INSUFFICIENT_INVENTORY');

    // Verify database state: Available inventory must NEVER be negative
    const inv = await prisma.inventory.findUnique({
      where: { productId },
    });

    expect(inv.totalQuantity).toBe(10);
    expect(inv.availableQuantity).toBeGreaterThanOrEqual(0);
    expect(inv.availableQuantity + inv.reservedQuantity).toBe(10);

    if (successRes.body.quantity === 7) {
      expect(inv.availableQuantity).toBe(3);
      expect(inv.reservedQuantity).toBe(7);
    } else {
      expect(inv.availableQuantity).toBe(5);
      expect(inv.reservedQuantity).toBe(5);
    }
  });

  test('High Contention: 20 parallel requests competing for 15 units', async () => {
    const product = await prisma.product.create({
      data: {
        sku: 'FLASH-SALE-99',
        name: 'Flash Sale Item',
        price: 9.99,
        inventory: {
          create: {
            totalQuantity: 15,
            availableQuantity: 15,
            reservedQuantity: 0,
          },
        },
      },
    });

    const productId = product.id;

    // Dispatch 20 concurrent requests for 2 units each (demanded: 40 units)
    const concurrentRequests = Array.from({ length: 20 }, (_, index) =>
      request(app)
        .post(`/inventory/${productId}/reserve`)
        .set('Idempotency-Key', `stress-key-${index}`)
        .send({ quantity: 2 })
    );

    const responses = await Promise.all(concurrentRequests);

    const successfulResponses = responses.filter((r) => r.status === 201);
    const failedResponses = responses.filter((r) => r.status === 409);

    // 15 units total / 2 units per request = exactly 7 requests can succeed
    expect(successfulResponses.length).toBe(7);
    expect(failedResponses.length).toBe(13);

    const inv = await prisma.inventory.findUnique({
      where: { productId },
    });

    expect(inv.totalQuantity).toBe(15);
    expect(inv.availableQuantity).toBe(1);
    expect(inv.reservedQuantity).toBe(14);
    expect(inv.availableQuantity).toBeGreaterThanOrEqual(0);
  });

  test('Concurrent Double-Confirm: Two simultaneous confirms on the same reservation', async () => {
    const product = await prisma.product.create({
      data: {
        sku: 'DOUBLE-CONFIRM-SKU',
        name: 'Double Confirm Test',
        price: 25.0,
        inventory: {
          create: {
            totalQuantity: 10,
            availableQuantity: 6,
            reservedQuantity: 4,
          },
        },
      },
    });

    const reservation = await prisma.reservation.create({
      data: {
        productId: product.id,
        quantity: 4,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // Fire two confirm requests at the exact same moment
    const [res1, res2] = await Promise.all([
      request(app).post(`/reservations/${reservation.id}/confirm`),
      request(app).post(`/reservations/${reservation.id}/confirm`),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const failed = res1.status === 409 ? res1 : res2;
    expect(failed.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Total quantity must be decremented ONLY ONCE (10 - 4 = 6), reserved must be 0
    const inv = await prisma.inventory.findUnique({
      where: { productId: product.id },
    });
    expect(inv.totalQuantity).toBe(6);
    expect(inv.availableQuantity).toBe(6);
    expect(inv.reservedQuantity).toBe(0);
  });

  test('Concurrent Confirm vs Release: One confirm and one release at the exact same moment', async () => {
    const product = await prisma.product.create({
      data: {
        sku: 'CONFIRM-VS-RELEASE',
        name: 'Race Item',
        price: 30.0,
        inventory: {
          create: {
            totalQuantity: 10,
            availableQuantity: 7,
            reservedQuantity: 3,
          },
        },
      },
    });

    const reservation = await prisma.reservation.create({
      data: {
        productId: product.id,
        quantity: 3,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // Fire confirm and release simultaneously
    const [confirmRes, releaseRes] = await Promise.all([
      request(app).post(`/reservations/${reservation.id}/confirm`),
      request(app).post(`/reservations/${reservation.id}/release`),
    ]);

    const statuses = [confirmRes.status, releaseRes.status].sort();
    // Exactly one must win, and one must fail
    expect(statuses).toEqual([200, 409]);

    const inv = await prisma.inventory.findUnique({
      where: { productId: product.id },
    });

    // Reserved quantity must NEVER be negative
    expect(inv.reservedQuantity).toBe(0);

    if (confirmRes.status === 200) {
      // Confirm won: total decremented to 7, available stayed 7
      expect(inv.totalQuantity).toBe(7);
      expect(inv.availableQuantity).toBe(7);
    } else {
      // Release won: total stayed 10, available restored to 10
      expect(inv.totalQuantity).toBe(10);
      expect(inv.availableQuantity).toBe(10);
    }
  });

  test('Concurrent Same-Key Retries: Simultaneous requests with identical Idempotency-Key', async () => {
    const product = await prisma.product.create({
      data: {
        sku: 'CONCURRENT-IDEMPOTENT',
        name: 'Retry Product',
        price: 40.0,
        inventory: {
          create: {
            totalQuantity: 10,
            availableQuantity: 10,
            reservedQuantity: 0,
          },
        },
      },
    });

    const sameKey = 'concurrent-key-999';

    // Send two requests at the exact same moment with the same key
    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/inventory/${product.id}/reserve`)
        .set('Idempotency-Key', sameKey)
        .send({ quantity: 4 }),
      request(app)
        .post(`/inventory/${product.id}/reserve`)
        .set('Idempotency-Key', sameKey)
        .send({ quantity: 4 }),
    ]);

    // Both should return success (one 201, one 200/201 replay)
    expect([200, 201]).toContain(res1.status);
    expect([200, 201]).toContain(res2.status);

    // Both must return the EXACT same reservation ID
    expect(res1.body.id).toBe(res2.body.id);
    expect(res1.body.quantity).toBe(4);

    // Verify isIdempotentReplay does NOT leak into JSON body
    expect(res1.body).not.toHaveProperty('isIdempotentReplay');
    expect(res2.body).not.toHaveProperty('isIdempotentReplay');

    // Inventory must be deducted only ONCE: 10 - 4 = 6 available, 4 reserved
    const inv = await prisma.inventory.findUnique({
      where: { productId: product.id },
    });
    expect(inv.availableQuantity).toBe(6);
    expect(inv.reservedQuantity).toBe(4);
  });

  test('Reserve Pre-Expires Overdue Stock: Recycles expired reservations inline before checking availability', async () => {
    const product = await prisma.product.create({
      data: {
        sku: 'PRE-EXPIRE-TEST',
        name: 'Pre-expiry Item',
        price: 15.0,
        inventory: {
          create: {
            totalQuantity: 10,
            availableQuantity: 1, // Only 1 available currently
            reservedQuantity: 9, // 9 reserved
          },
        },
      },
    });

    // Create a reservation of 5 units that expired 10 seconds ago (background job hasn't run yet)
    await prisma.reservation.create({
      data: {
        productId: product.id,
        quantity: 5,
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 10 * 1000), // Expired 10s ago
      },
    });

    // New customer wants to reserve 4 units.
    // If expired stock isn't recycled, this would fail (4 > 1).
    // Because reserve recycles overdue stock first, available becomes 1 + 5 = 6, and 4 succeeds!
    const reserveRes = await request(app)
      .post(`/inventory/${product.id}/reserve`)
      .send({ quantity: 4 });

    expect(reserveRes.status).toBe(201);
    expect(reserveRes.body.quantity).toBe(4);

    const inv = await prisma.inventory.findUnique({
      where: { productId: product.id },
    });

    // Available: 1 + 5 (recycled) - 4 (new reservation) = 2
    // Reserved: 9 - 5 (expired) + 4 (new reservation) = 8
    expect(inv.availableQuantity).toBe(2);
    expect(inv.reservedQuantity).toBe(8);
  });
});
