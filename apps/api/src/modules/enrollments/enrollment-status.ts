import type { EnrollmentStatus } from '../../generated/prisma/client.js';

/**
 * Allowed enrollment transitions through the API. `pending_payment -> active` is deliberately
 * absent: only a confirmed payment (the Stripe webhook) may activate a paid enrollment.
 */
const TRANSITIONS: Record<EnrollmentStatus, readonly EnrollmentStatus[]> = {
  active: ['dropped', 'completed'],
  pending_payment: ['dropped'],
  dropped: ['active'],
  completed: ['active'],
};

export function canTransition(from: EnrollmentStatus, to: EnrollmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Every status except `dropped` occupies a seat in the section (counted in enrolled_count). */
export function holdsSeat(status: EnrollmentStatus): boolean {
  return status !== 'dropped';
}
