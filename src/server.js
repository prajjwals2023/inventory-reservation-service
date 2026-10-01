require('dotenv').config();
const app = require('./app');
const prisma = require('./config/database');
const { startReservationExpiryJob, stopReservationExpiryJob } = require('./jobs/expireReservations');

const PORT = parseInt(process.env.PORT || '3000', 10);

async function startServer() {
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

    const shutdown = async (signal) => {
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

module.exports = { startServer };
