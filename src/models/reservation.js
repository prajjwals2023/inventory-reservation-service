const ReservationStatus = Object.freeze({
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  RELEASED: 'RELEASED',
  EXPIRED: 'EXPIRED',
});

const TERMINAL_STATES = new Set([
  ReservationStatus.CONFIRMED,
  ReservationStatus.RELEASED,
  ReservationStatus.EXPIRED,
]);

function canTransition(currentStatus, targetStatus) {
  if (currentStatus === ReservationStatus.PENDING) {
    return [
      ReservationStatus.CONFIRMED,
      ReservationStatus.RELEASED,
      ReservationStatus.EXPIRED,
    ].includes(targetStatus);
  }
  return false;
}

module.exports = {
  ReservationStatus,
  TERMINAL_STATES,
  canTransition,
};
