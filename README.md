# Inventory Reservation Service

A high-concurrency, robust backend service for e-commerce platforms that manages product inventory and temporary reservations. Designed to eliminate race conditions, prevent overselling, enforce request idempotency, and automatically expire unconfirmed reservations after 15 minutes.

---

## Table of Contents
1. [Key Features](#key-features)
2. [Architecture & Design Decisions](#architecture--design-decisions)
   - [Concurrency Control & Zero Overselling (Reserve)](#1-concurrency-control--zero-overselling-reserve)
   - [Concurrency Safety for Confirm & Release](#2-concurrency-safety-for-confirm--release)
   - [Idempotency & Concurrent Retries](#3-idempotency--concurrent-retries)
   - [Reservation Expiration (15-Minute TTL & Pre-Expiry)](#4-reservation-expiration-15-minute-ttl--pre-expiry)
   - [Reservation State Machine](#5-reservation-state-machine)
3. [Technology Stack](#technology-stack)
4. [Database Schema & Architecture](#database-schema--architecture)
5. [Setup & Running](#setup--running)
   - [Option A: Running with Docker Compose (Recommended)](#option-a-running-with-docker-compose-recommended)
   - [Option B: Running Locally (Node.js & PostgreSQL)](#option-b-running-locally-nodejs--postgresql)
6. [Running Automated Tests](#running-automated-tests)
7. [API Documentation](#api-documentation)
   - [Interactive Swagger UI](#interactive-swagger-ui)
   - [Endpoints Specification & Examples](#endpoints-specification--examples)
8. [Known Limitations & Future Scaling](#known-limitations--future-scaling)

---

## Key Features

- **Pessimistic Row-Level Locking**: Uses PostgreSQL `SELECT ... FOR UPDATE` inside atomic transactions to eliminate race conditions and guarantee zero overselling.
- **Conditional State Transitions**: `confirmReservation` and `releaseReservation` execute conditional updates (`UPDATE ... WHERE id = :id AND status = 'PENDING'`) inside the locked transaction, mathematically preventing double-confirmations or confirm-vs-release corruption.
- **Idempotency with Concurrent Retry Resolution**: Evaluates `Idempotency-Key` headers using SHA-256 payload hashing. If two requests with the same key arrive simultaneously, the unique constraint conflict (`P2002`) is caught and safely resolves to the original reservation.
- **Pre-Expiry on Reserve**: Reservations that expired prior to a new reservation attempt are recycled immediately inside the transaction, avoiding artificial stock exhaustion while waiting for the background worker.
- **Dual-Layer Expiry Mechanism**: Combines a proactive background worker (running every 30s) and reactive lazy checks on access to ensure stale reservations cannot be confirmed or read. Multi-instance safe due to conditional updates.
- **Complete Product Management**: Full CRUD (`POST`, `GET`, `PUT`, `DELETE`) for products, along with inventory restocking and inventory level views.
- **Interactive OpenAPI Documentation**: Built-in Swagger UI served live at `/api-docs`.
- **Automated Test Suite**: 22 automated Jest tests covering all 8 business scenarios, concurrent double-confirms, confirm-vs-release races, same-key retries, and high-contention stress tests.

---

## Architecture & Design Decisions

### 1. Concurrency Control & Zero Overselling (Reserve)

#### The Problem:
If a product has 10 units in stock and Request A (reserve 7) and Request B (reserve 5) arrive simultaneously, standard read-then-write logic creates a race condition where both see 10 available and reserve 12 units total.

#### The Solution:
Inside a Prisma interactive transaction (`prisma.$transaction`):
1. The service executes a pessimistic row lock:
   ```sql
   SELECT * FROM "inventories" WHERE "productId" = $1 FOR UPDATE;
   ```
2. Any concurrent transaction attempting to reserve the same product is held in a queue by PostgreSQL until the active transaction commits or rolls back.
3. Pre-expiry check: Overdue reservations for this product are immediately expired and restored to `availableQuantity`.
4. The locked row is checked: `if (inventory.availableQuantity < requestedQuantity) throw InsufficientInventoryError`.
5. Stock is atomically adjusted:
   - `availableQuantity -= requestedQuantity`
   - `reservedQuantity += requestedQuantity`
6. The `Reservation` record is created with status `PENDING` and committed.
7. The lock is released; the waiting transaction acquires the lock, observes the remaining stock (e.g. 3), and is rejected with `409 Conflict` (`INSUFFICIENT_INVENTORY`).

---

### 2. Concurrency Safety for Confirm & Release

#### The Problem:
If two `confirm` requests for the same reservation arrive at the exact same millisecond, or if a `confirm` and a `release` arrive concurrently, checking status before entering the transaction or updating by `id` only allows both to apply, causing `totalQuantity` to decrement twice or `reservedQuantity` to drop below zero.

#### The Solution:
1. Inside the transaction, lock the product's inventory row.
2. Execute a **conditional update** on the reservation:
   ```javascript
   // For Confirm:
   const r = await tx.reservation.updateMany({
     where: { id: reservationId, status: 'PENDING', expiresAt: { gt: now } },
     data: { status: 'CONFIRMED', confirmedAt: now },
   });
   if (r.count === 0) throw new InvalidStateError(...);

   // For Release:
   const r = await tx.reservation.updateMany({
     where: { id: reservationId, status: 'PENDING' },
     data: { status: 'RELEASED', releasedAt: now },
   });
   if (r.count === 0) throw new InvalidStateError(...);
   ```
3. **Only if `r.count === 1`** does the service adjust `totalQuantity` and `reservedQuantity`.
4. If a concurrent confirm or release arrives, its `updateMany` returns `r.count === 0` and it is rejected with `409 Conflict`. `reservedQuantity` is mathematically prevented from going negative.

---

### 3. Idempotency & Concurrent Retries

Clients on flaky connections may retry reservation requests:
```http
POST /inventory/101/reserve
Idempotency-Key: 7f83-abc-123
```

#### How it works:
1. Fast-path lookup: If `Idempotency-Key` exists and the SHA-256 payload hash matches, returns the cached response with `200 OK` and `X-Cache-Lookup: HIT`.
2. Different payload with same key: Rejects with `422 Unprocessable Entity` (`IDEMPOTENCY_CONFLICT`).
3. **Simultaneous same-key race condition**: If two requests arrive at the exact same millisecond, both miss the initial lookup. The second request hits the unique constraint on `idempotencyKey` (`P2002`). The service catches `P2002`, re-queries the newly committed `IdempotencyRecord`, verifies the payload hash, and cleanly returns the original reservation with HTTP 200 without exposing unhandled errors or leaking internal replay flags.

---

### 4. Reservation Expiration (15-Minute TTL & Pre-Expiry)

Reservations default to a 15-minute time-to-live (`RESERVATION_TTL_MINUTES=15`).

To prevent stale state, a **Dual-Layer Expiry** strategy is implemented:
1. **Pre-Expiry on Reserve**: When a customer attempts to reserve stock, any overdue reservations for that specific product are expired inline inside the transaction *before* checking available quantity. This prevents artificial `INSUFFICIENT_INVENTORY` rejections between worker intervals.
2. **Active Background Worker (`src/jobs/expireReservations.js`)**:
   - An interval job executes every 30 seconds (`CLEANUP_INTERVAL_SECONDS=30`).
   - Uses conditional `updateMany({ where: { id, status: 'PENDING' } })`, making it safe to run across multiple worker instances without double-restoring stock.
3. **Lazy Evaluation on Access**:
   - Querying or attempting to confirm an expired reservation triggers immediate inline expiration and returns `409 Conflict`.
4. **Manual Trigger Endpoint**:
   - `POST /reservations/cleanup-expired` allows operators to trigger cleanup on-demand (protected by `X-Admin-Key` header matching `ADMIN_API_KEY`).

---

### 5. Reservation State Machine

```
              ┌─────────────┐
              │   PENDING   │
              └──────┬──────┘
         ┌───────────┼───────────┐
         │           │           │
         ▼           ▼           ▼
   ┌───────────┐┌──────────┐┌───────────┐
   │ CONFIRMED ││ RELEASED ││  EXPIRED  │
   └───────────┘└──────────┘└───────────┘
```

- **PENDING**: Initial state upon reservation.
- **CONFIRMED**: Order placed; stock permanently committed (`totalQuantity -= quantity`, `reservedQuantity -= quantity`). Terminal state.
- **RELEASED**: Customer cancelled checkout; stock returned (`availableQuantity += quantity`, `reservedQuantity -= quantity`). Terminal state.
- **EXPIRED**: 15 minutes elapsed without confirmation; stock returned. Terminal state.
- **Invalid Transitions**:
  - Confirming already confirmed / released / expired reservation -> `409 Conflict`
  - Releasing already confirmed / released / expired reservation -> `409 Conflict`

---

## Technology Stack

| Layer | Technology |
| :--- | :--- |
| **Language** | TypeScript 5.6 (strict mode) |
| **Runtime** | Node.js (v20+ / v22) |
| **Web Framework** | Express.js (`@types/express`) |
| **ORM / Query Builder** | Prisma ORM (with generated TypeScript types) |
| **Database** | PostgreSQL 16 (ACID transactions, pessimistic row locking) |
| **Documentation** | OpenAPI 3.0 / Swagger UI (`swagger-ui-express`) |
| **Testing** | Jest, Supertest & `ts-jest` |
| **Dev Server** | `ts-node-dev` (fast TypeScript execution with hot-reload) |
| **Containerization** | Docker & Docker Compose |

---

## Database Schema & Architecture

```mermaid
erDiagram
    PRODUCT ||--|| INVENTORY : "has one"
    PRODUCT ||--o{ RESERVATION : "has many"

    PRODUCT {
        string id PK "UUID"
        string sku UK "Unique Product SKU"
        string name "Product Name"
        string description "Product Description"
        decimal price "Product Price (Decimal 10,2)"
        datetime createdAt
        datetime updatedAt
    }

    INVENTORY {
        string id PK "UUID"
        string productId FK "Unique reference to Product"
        int totalQuantity "Total inventory owned"
        int availableQuantity "Unreserved inventory ready for purchase"
        int reservedQuantity "Temporarily reserved inventory"
        datetime updatedAt
    }

    RESERVATION {
        string id PK "UUID"
        string productId FK "Reference to Product"
        int quantity "Number of units reserved"
        string status "PENDING | CONFIRMED | RELEASED | EXPIRED"
        string idempotencyKey UK "Optional unique request key"
        datetime expiresAt "Expiration timestamp (NOW + 15m)"
        datetime confirmedAt "Timestamp when confirmed"
        datetime releasedAt "Timestamp when released"
        datetime createdAt
    }

    IDEMPOTENCY_RECORD {
        string id PK "UUID"
        string key UK "Idempotency-Key from HTTP header"
        string requestPath "Request URL path"
        string requestMethod "HTTP Method"
        string requestHash "SHA-256 payload hash"
        int statusCode "HTTP Status Code"
        string responseBody "Cached JSON response"
        datetime createdAt
    }
```

---

## Setup & Running

### Configuration Details
- **Docker Compose**: Maps container port `5432` to host port `5434` (to avoid any port collision if PostgreSQL is already running locally on port 5432).
- **Database Connection String for Local Development / Tests**:
  ```env
  DATABASE_URL="postgresql://postgres:postgres@localhost:5434/inventory_db?schema=public"
  ```
  *(See `.env.example` for reference)*.

---

### Option A: Running with Docker Compose (Recommended)

To start the complete application and its PostgreSQL database with a single command:

```bash
docker compose up --build
```

- **API Base URL**: `http://localhost:3000`
- **Interactive Swagger Documentation**: `http://localhost:3000/api-docs`
- **Health Check**: `http://localhost:3000/health`

To stop the containers:
```bash
docker compose down
```

---

### Option B: Running Locally (Node.js & PostgreSQL)

#### 1. Prerequisites:
- Node.js v20+ or v22+
- Running PostgreSQL instance (or start PostgreSQL via `docker compose up -d db`)

#### 2. Configure Environment:
Edit `.env` (or copy `.env.example`):
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5434/inventory_db?schema=public"
PORT=3000
RESERVATION_TTL_MINUTES=15
CLEANUP_INTERVAL_SECONDS=30
NODE_ENV=development
ADMIN_API_KEY="admin-secret-key-123"
```

#### 3. Install Dependencies & Migrate Database:
```bash
npm install
npx prisma db push
```

#### 4. Build & Start the Application:
For development with auto-reload (using `ts-node-dev`):
```bash
npm run dev
```

To compile TypeScript and run production build:
```bash
npm run build
npm start
```

---

## Running Automated Tests

The automated test suite runs via Jest and verifies all 8 business scenarios, concurrency race conditions, and product management:

```bash
npm test
```

### Scenarios Covered by Automated Tests (22 Tests Total):
1. **Successful reservation**: Validates stock decrement in `availableQuantity`, increment in `reservedQuantity`, and creation of `PENDING` reservation with future `expiresAt`.
2. **Insufficient inventory**: Attempts to reserve more units than available; verifies `409 INSUFFICIENT_INVENTORY` error and ensures inventory remains unaltered.
3. **Confirming a reservation**: Confirms a reservation; validates `CONFIRMED` status, sets `confirmedAt`, and permanently deducts stock from `totalQuantity`.
4. **Releasing a reservation**: Releases a reservation; validates `RELEASED` status, sets `releasedAt`, and restores inventory to `availableQuantity`.
5. **Expired reservation**: Simulates an expired reservation past 15m; verifies lazy/job expiration, stock restoration, and rejection of confirmation attempts.
6. **Duplicate / idempotent requests**: Re-sends identical request with `Idempotency-Key`; validates identical cached response, `X-Cache-Lookup: HIT`, and verifies stock was deducted only once.
7. **Idempotency conflict**: Re-uses idempotency key with different payload; verifies `422 IDEMPOTENCY_CONFLICT`.
8. **Invalid state transitions**: Verifies `409 INVALID_STATE_TRANSITION` on confirming/releasing already confirmed, released, or expired reservations.
9. **Background Expiry Job**: Tests interval worker directly to verify it automatically cleans up overdue reservations.
10. **Product CRUD Management**: Tests `POST /products`, `GET /products`, `GET /products/:id`, `PUT /products/:id`, `DELETE /products/:id`, and restocking.
11. **Concurrent reservation race conditions**:
    - **Prompt Scenario**: 10 units in stock. Simultaneous requests for 7 units and 5 units sent via `Promise.all`. Exactly one succeeds (`201`), one is rejected (`409`), and available inventory never drops below zero.
    - **High-Contention Stress**: 20 parallel requests competing for 15 available units. Exactly 7 succeed, 13 fail, and final inventory reflects exactly 1 available and 14 reserved.
    - **Concurrent Double-Confirm**: Two simultaneous confirms on the same reservation. Exactly one succeeds, one fails with 409, and total stock is decremented only once.
    - **Concurrent Confirm vs Release**: Confirm and release sent at the same moment. Exactly one succeeds, one fails with 409, and reserved quantity never drops below zero.
    - **Concurrent Same-Key Retries**: Simultaneous requests with identical `Idempotency-Key`. Both return the same reservation cleanly without unique constraint failure.
    - **Reserve Pre-Expiry**: Verifies that a reservation request recycles overdue stock for that product inline before checking availability.

---

## API Documentation

### Interactive Swagger UI
Visit **`http://localhost:3000/api-docs`** in your browser for interactive OpenAPI documentation with live testing capabilities.

---

### Endpoints Specification & Examples

#### 1. Create a Product
- **Method**: `POST /products`
- **Request Body**:
  ```json
  {
    "sku": "KB-RGB-001",
    "name": "Wireless RGB Mechanical Keyboard",
    "description": "Hot-swappable mechanical switches with 2.4GHz wireless",
    "price": 99.99,
    "initialStock": 10
  }
  ```
- **Response**: `201 Created`

#### 2. Update a Product
- **Method**: `PUT /products/:id`
- **Request Body**:
  ```json
  {
    "name": "Wireless RGB Mechanical Keyboard v2",
    "price": 109.99
  }
  ```
- **Response**: `200 OK`

#### 3. Delete a Product
- **Method**: `DELETE /products/:id`
- **Response**: `200 OK`

#### 4. View Current Inventory
- **Method**: `GET /inventory/:productId` (also available via `GET /products/:id/inventory`)
- **Response**: `200 OK`
  ```json
  {
    "productId": "e81d77a0-0932-46be-8f74-320c242ef998",
    "productName": "Wireless RGB Mechanical Keyboard",
    "sku": "KB-RGB-001",
    "totalQuantity": 10,
    "availableQuantity": 10,
    "reservedQuantity": 0,
    "updatedAt": "2026-09-30T16:00:00.000Z"
  }
  ```

#### 5. Restock Inventory
- **Method**: `POST /inventory/:productId/restock`
- **Request Body**:
  ```json
  {
    "quantity": 25
  }
  ```
- **Response**: `200 OK`

#### 6. Reserve Inventory (With Idempotency Key)
- **Method**: `POST /inventory/:productId/reserve` (also supports `POST /reservations`)
- **Headers**:
  ```http
  Idempotency-Key: 7f83-abc-123
  Content-Type: application/json
  ```
- **Request Body**:
  ```json
  {
    "quantity": 4
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "id": "c3e98124-7629-45d2-9ea3-ff59f518e381",
    "productId": "e81d77a0-0932-46be-8f74-320c242ef998",
    "quantity": 4,
    "status": "PENDING",
    "idempotencyKey": "7f83-abc-123",
    "expiresAt": "2026-09-30T16:15:00.000Z",
    "confirmedAt": null,
    "releasedAt": null,
    "createdAt": "2026-09-30T16:00:00.000Z"
  }
  ```

#### 7. View Reservation Details
- **Method**: `GET /reservations/:id`
- **Response**: `200 OK`

#### 8. Confirm a Reservation
- **Method**: `POST /reservations/:id/confirm`
- **Response**: `200 OK`

#### 9. Release a Reservation
- **Method**: `POST /reservations/:id/release`
- **Response**: `200 OK`

#### 10. Manual Expiration Cleanup
- **Method**: `POST /reservations/cleanup-expired`
- **Headers**: `X-Admin-Key: admin-secret-key-123` (optional, configurable)
- **Response**: `200 OK`
  ```json
  {
    "expiredCount": 3
  }
  ```

---

## Known Limitations & Future Scaling

1. **Flash-Sale SKU Contention**:
   - Under extremely high traffic (>10,000 requests/sec on a single SKU), PostgreSQL row locks can cause database connection queueing.
   - *Future Solution*: Introduce an in-memory Redis cluster with atomic Lua scripts (`DECRBY`) as a fast pre-reservation gatekeeper, synchronizing to PostgreSQL asynchronously via transactional outbox.
2. **Multi-Item Order Atomic Reservations**:
   - Current implementation reserves on a per-product basis.
   - *Future Solution*: Accept an array of items (`items: [{ productId, quantity }]`). When locking multiple products in a single transaction, sort product IDs lexicographically before acquiring locks to guarantee deadlock avoidance.
