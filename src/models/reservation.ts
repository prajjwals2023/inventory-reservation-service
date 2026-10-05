export enum ReservationStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  RELEASED = 'RELEASED',
  EXPIRED = 'EXPIRED',
}

export const TERMINAL_STATES: ReadonlySet<ReservationStatus> = new Set([
  ReservationStatus.CONFIRMED,
  ReservationStatus.RELEASED,
  ReservationStatus.EXPIRED,
]);

const VALID_TRANSITIONS: Readonly<Record<ReservationStatus, ReservationStatus[]>> = {
  [ReservationStatus.PENDING]: [
    ReservationStatus.CONFIRMED,
    ReservationStatus.RELEASED,
    ReservationStatus.EXPIRED,
  ],
  [ReservationStatus.CONFIRMED]: [],
  [ReservationStatus.RELEASED]: [],
  [ReservationStatus.EXPIRED]: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
