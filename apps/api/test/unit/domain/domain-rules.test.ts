import { describe, expect, it } from 'vitest';
import { Prisma, type EnrollmentStatus } from '../../../src/generated/prisma/client.js';
import { canTransition, holdsSeat } from '../../../src/modules/enrollments/enrollment-status.js';
import { summarize } from '../../../src/modules/grades/grades.service.js';
import { DEFAULT_FEATURES, readSettings } from '../../../src/modules/tenants/settings.js';

describe('enrollment status machine', () => {
  const statuses: EnrollmentStatus[] = ['pending_payment', 'active', 'dropped', 'completed'];
  const allowed = new Set([
    'active->dropped',
    'active->completed',
    'pending_payment->dropped',
    'dropped->active',
    'completed->active',
  ]);

  it.each(
    statuses.flatMap((from) =>
      statuses.filter((to) => to !== from).map((to) => [from, to] as const),
    ),
  )('%s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(allowed.has(`${from}->${to}`));
  });

  it('never activates a pending payment through the API', () => {
    expect(canTransition('pending_payment', 'active')).toBe(false);
  });

  it('counts every status but dropped against capacity', () => {
    expect(statuses.filter(holdsSeat)).toEqual(['pending_payment', 'active', 'completed']);
  });
});

describe('grade summary', () => {
  const grade = (score: string, maxScore: string) => ({
    score: new Prisma.Decimal(score),
    maxScore: new Prisma.Decimal(maxScore),
  });

  it('adds decimals exactly', () => {
    expect(summarize([grade('0.1', '1'), grade('0.2', '1')])).toEqual({
      count: 2,
      totalScore: 0.3,
      totalMaxScore: 2,
      percentage: 15,
    });
  });

  it('rounds the percentage to two places, and has none before any grade', () => {
    expect(summarize([grade('1', '3')]).percentage).toBe(33.33);
    expect(summarize([])).toEqual({ count: 0, totalScore: 0, totalMaxScore: 0, percentage: null });
  });
});

describe('school settings', () => {
  it('fills in defaults for missing features', () => {
    expect(readSettings({ features: { ai: true } })).toEqual({
      branding: {},
      features: { ...DEFAULT_FEATURES, ai: true },
    });
  });

  it('degrades malformed stored values to defaults instead of failing', () => {
    expect(readSettings(null)).toEqual({ branding: {}, features: DEFAULT_FEATURES });
    expect(readSettings({ branding: { primaryColor: 'not-a-colour' }, features: 'yes' })).toEqual({
      branding: {},
      features: DEFAULT_FEATURES,
    });
  });
});
