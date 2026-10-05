import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import swaggerDoc from './config/swaggerDoc';
import productRoutes from './routes/productRoutes';
import inventoryRoutes from './routes/inventoryRoutes';
import reservationRoutes from './routes/reservationRoutes';
import { errorHandler, NotFoundError } from './middleware/errorHandler';

const app = express();

app.use(cors());
app.use(express.json());

// Interactive Swagger UI documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// Healthcheck endpoint
app.get('/health', (_req: Request, res: Response) => {
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
app.use((req: Request, _res: Response, next: NextFunction) => {
  next(new NotFoundError(`Endpoint '${req.method} ${req.originalUrl}' not found`));
});

// Centralized error handler
app.use(errorHandler);

export default app;
