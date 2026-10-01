const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerDoc = require('./config/swaggerDoc');
const productRoutes = require('./routes/productRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const reservationRoutes = require('./routes/reservationRoutes');
const { errorHandler, NotFoundError } = require('./middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json());

// Interactive Swagger UI documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// Healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'inventory-reservation-service',
  });
});

// Primary API routes
app.use('/products', productRoutes);
app.use('/inventory', inventoryRoutes);
app.use('/reservations', reservationRoutes);

// Catch 404 for unhandled routes
app.use((req, res, next) => {
  next(new NotFoundError(`Endpoint '${req.method} ${req.originalUrl}' not found`));
});

// Centralized error handler
app.use(errorHandler);

module.exports = app;
