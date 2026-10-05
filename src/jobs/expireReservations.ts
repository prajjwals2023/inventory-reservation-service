import reservationService from '../services/reservationService';

let intervalHandle: NodeJS.Timeout | null = null;

export function startReservationExpiryJob(intervalSeconds?: number): void {
  const seconds = intervalSeconds || parseInt(process.env.CLEANUP_INTERVAL_SECONDS || '30', 10);
  const intervalMs = seconds * 1000;

  if (intervalHandle) {
    clearInterval(intervalHandle);
  }

  intervalHandle = setInterval(async () => {
    try {
      const result = await reservationService.expireOverdueReservations();
      if (result.expiredCount > 0 && process.env.NODE_ENV !== 'test') {
        console.log(`[ExpiryJob] Expired ${result.expiredCount} overdue reservation(s)`);
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.error('[ExpiryJob] Error running reservation expiry job:', err);
      }
    }
  }, intervalMs);

  // Prevent background job from blocking process exit
  if (intervalHandle.unref) {
    intervalHandle.unref();
  }

  if (process.env.NODE_ENV !== 'test') {
    console.log(`[ExpiryJob] Reservation expiry job scheduled every ${seconds}s`);
  }
}

export function stopReservationExpiryJob(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
