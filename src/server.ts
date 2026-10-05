import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import prisma from './config/database';
import { startReservationExpiryJob, stopReservationExpiryJob } from './jobs/expireReservations';

const PORT = parseInt(process.env.PORT || '3000', 10);

export async function startServer(): Promise<void> {
  try {
    // Verify database connection
    await prisma.$connect();
    console.log('Successfully connected to database.');

    // Start background job for reservation expiry
    startReservationExpiryJob();

    const server = app.listen(PORT, () => {
      console.log(`Inventory Reservation Service running on port ${PORT}`);
      console.log(`API Documentation available at: http://localhost:${PORT}/api-docs`);
    });

    const shutdown = async (signal: string) => {
      console.log(`\nReceived ${signal}. Gracefully shutting down...`);
      stopReservationExpiryJob();
      server.close(async () => {
        await prisma.$disconnect();
        console.log('Database disconnected. Process terminated.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}
