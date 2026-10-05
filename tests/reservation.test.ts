import request from 'supertest';
import app from '../src/app';
import prisma from '../src/config/database';
import { startReservationExpiryJob, stopReservationExpiryJob } from '../src/jobs/expireReservations';

describe('Reservation Lifecycle and Business Scenarios', () => {
  let testProductId: string;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    stopReservationExpiryJob();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset DB before each test
    await prisma.idempotencyRecord.deleteMany({});
    await prisma.reservation.deleteMany({});
    await prisma.inventory.deleteMany({});
    await prisma.product.deleteMany({});

    // Create a fresh test product with 10 units in stock
    const product = await prisma.product.create({
      data: {
        sku: 'TEST-SKU-100',
        name: 'Test Product 100',
        price: 50.0,
        inventory: {
          create: {
            totalQuantity: 10,
            availableQuantity: 10,
            reservedQuantity: 0,
          },
        },
      },
    });
    testProductId = product.id;
  });

  test('1. Successful reservation - reserves available inventory', async () => {
    const res = await request(app)
      .post(`/inventory/${testProductId}/reserve`)
      .send({ quantity: 4 });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.productId).toBe(testProductId);
    expect(res.body.quantity).toBe(4);
    expect(res.body.status).toBe('PENDING');
    expect(res.body).not.toHaveProperty('isIdempotentReplay');
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Verify inventory state
    const invRes = await request(app).get(`/inventory/${testProductId}`);
    expect(invRes.body.totalQuantity).toBe(10);
    expect(invRes.body.availableQuantity).toBe(6);
    expect(invRes.body.reservedQuantity).toBe(4);
  });

  test('2. Insufficient inventory - rejects reservation exceeding available stock', async () => {
    const res = await request(app)
      .post(`/inventory/${testProductId}/reserve`)
      .send({ quantity: 15 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_INVENTORY');

    // Verify inventory remained completely untouched
    const invRes = await request(app).get(`/inventory/${testProductId}`);
    expect(invRes.body.availableQuantity).toBe(10);
    expect(invRes.body.reservedQuantity).toBe(0);
  });

  test('3. Confirming a reservation - permanently commits inventory', async () => {
    // Reserve 3 units
    const reserveRes = await request(app)
      .post(`/inventory/${testProductId}/reserve`)
      .send({ quantity: 3 });

    const reservationId = reserveRes.body.id;

    // Confirm reservation
    const confirmRes = await request(app).post(`/reservations/${reservationId}/confirm`);

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.id).toBe(reservationId);
    expect(confirmRes.body.status).toBe('CONFIRMED');
    expect(confirmRes.body).toHaveProperty('confirmedAt');

    // Verify inventory: total decreases to 7, available stays 7, reserved returns to 0
    const invRes = await request(app).get(`/inventory/${testProductId}`);
    expect(invRes.body.totalQuantity).toBe(7);
    expect(invRes.body.availableQuantity).toBe(7);
    expect(invRes.body.reservedQuantity).toBe(0);
  });

  test('4. Releasing a reservation - restores inventory to available', async () => {
    // Reserve 4 units
    const reserveRes = await request(app)
      .post(`/inventory/${testProductId}/reserve`)
      .send({ quantity: 4 });

    const reservationId = reserveRes.body.id;

    // Release reservation
    const releaseRes = await request(app).post(`/reservations/${reservationId}/release`);

    expect(releaseRes.status).toBe(200);
    expect(releaseRes.body.id).toBe(reservationId);
    expect(releaseRes.body.status).toBe('RELEASED');
    expect(releaseRes.body).toHaveProperty('releasedAt');

    // Verify inventory: total remains 10, available restored to 10, reserved returns to 0
    const invRes = await request(app).get(`/inventory/${testProductId}`);
    expect(invRes.body.totalQuantity).toBe(10);
    expect(invRes.body.availableQuantity).toBe(10);
    expect(invRes.body.reservedQuantity).toBe(0);
  });

  test('5. Expired reservation - restores available inventory and rejects confirmation', async () => {
    // Create an expired reservation manually in the DB (expiresAt in the past)
    const pastDate = new Date(Date.now() - 60 * 1000); // 1 minute ago
    await prisma.$transaction(async (tx) => {
      await tx.inventory.update({
        where: { productId: testProductId },
        data: {
          availableQuantity: 6,
          reservedQuantity: 4,
        },
      });
      await tx.reservation.create({
        data: {
          id: 'expired-res-123',
          productId: testProductId,
          quantity: 4,
          status: 'PENDING',
          expiresAt: pastDate,
        },
      });
    });

    // Attempting to confirm the expired reservation must trigger expiry and fail
    const confirmRes = await request(app).post('/reservations/expired-res-123/confirm');
    expect(confirmRes.status).toBe(409);
    expect(confirmRes.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Verify the reservation status is now EXPIRED
    const getRes = await request(app).get('/reservations/expired-res-123');
    expect(getRes.status).toBe(200);
    expect(getRes.body.status).toBe('EXPIRED');

    // Verify inventory was restored
    const invRes = await request(app).get(`/inventory/${testProductId}`);
    expect(invRes.body.availableQuantity).toBe(10);
    expect(invRes.body.reservedQuantity).toBe(0);
  });

  test('6. Duplicate / idempotent request - does not duplicate reservations', async () => {
    const idempotencyKey = 'idempotent-key-xyz-789';

    // First request
    const firstRes = await request(app)
      .post(`/inventory/${testProductId}/reserve`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ quantity: 4 });

    expect(firstRes.status).toBe(201);
    const reservationId = firstRes.body.id;
    expect(firstRes.body).not.toHaveProperty('isIdempotentReplay');

    // Second request with identical key and payload (network retry)
    const retryRes = await request(app)
      .post(`/inventory/${testProductId}/reserve`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ quantity: 4 });

    expect(retryRes.status).toBe(200);
    expect(retryRes.headers['x-cache-lookup']).toBe('HIT');
    expect(retryRes.body.id).toBe(reservationId);
    expect(retryRes.body.quantity).toBe(4);
    expect(retryRes.body).not.toHaveProperty('isIdempotentReplay');

    // Verify inventory was only deducted ONCE (10 - 4 = 6 available)
    const invRes = await request(app).get(`/inventory/${testProductId}`);
    expect(invRes.body.availableQuantity).toBe(6);
    expect(invRes.body.reservedQuantity).toBe(4);
  });

  test('6b. Idempotent request with different parameters returns 422', async () => {
    const idempotencyKey = 'key-conflict-check';

    // First request
    await request(app)
      .post(`/inventory/${testProductId}/reserve`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ quantity: 3 });

    // Conflicting request with different quantity
    const conflictRes = await request(app)
      .post(`/inventory/${testProductId}/reserve`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ quantity: 5 });

    expect(conflictRes.status).toBe(422);
    expect(conflictRes.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('7. Invalid reservation state transitions', async () => {
    // Create reservation
    const res = await request(app)
      .post(`/inventory/${testProductId}/reserve`)
      .send({ quantity: 2 });
    const reservationId = res.body.id;

    // Confirm it
    await request(app).post(`/reservations/${reservationId}/confirm`);

    // Attempting to confirm again -> 409
    const reConfirm = await request(app).post(`/reservations/${reservationId}/confirm`);
    expect(reConfirm.status).toBe(409);
    expect(reConfirm.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Attempting to release a confirmed reservation -> 409
    const releaseConfirmed = await request(app).post(`/reservations/${reservationId}/release`);
    expect(releaseConfirmed.status).toBe(409);
    expect(releaseConfirmed.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Create another reservation and release it
    const res2 = await request(app)
      .post(`/inventory/${testProductId}/reserve`)
      .send({ quantity: 2 });
    const reservation2Id = res2.body.id;

    await request(app).post(`/reservations/${reservation2Id}/release`);

    // Attempting to confirm a released reservation -> 409
    const confirmReleased = await request(app).post(`/reservations/${reservation2Id}/confirm`);
    expect(confirmReleased.status).toBe(409);
    expect(confirmReleased.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  test('8. Background Expiry Job - automatically cleans up overdue reservations via interval worker', async () => {
    // Insert an overdue reservation directly into DB
    const pastDate = new Date(Date.now() - 30 * 1000);
    await prisma.$transaction(async (tx) => {
      await tx.inventory.update({
        where: { productId: testProductId },
        data: { availableQuantity: 7, reservedQuantity: 3 },
      });
      await tx.reservation.create({
        data: {
          id: 'worker-test-res',
          productId: testProductId,
          quantity: 3,
          status: 'PENDING',
          expiresAt: pastDate,
        },
      });
    });

    // Start background job with a 0.2s interval
    startReservationExpiryJob(0.2);

    // Wait 500ms for job to fire
    await new Promise((resolve) => setTimeout(resolve, 500));
    stopReservationExpiryJob();

    // Check that reservation status was changed to EXPIRED directly by the background job
    const updated = await prisma.reservation.findUnique({
      where: { id: 'worker-test-res' },
    });
    expect(updated?.status).toBe('EXPIRED');

    // Check that inventory was automatically restored
    const inv = await prisma.inventory.findUnique({
      where: { productId: testProductId },
    });
    expect(inv?.availableQuantity).toBe(10);
    expect(inv?.reservedQuantity).toBe(0);
  });
});
