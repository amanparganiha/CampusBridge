import { z } from 'zod';

/** Visual identity shown to a school's users (admin app theme, emails). Public information. */
export const brandingSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1d4ed8.')
    .optional(),
  logoUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
});

/** Per-school feature switches. */
export const featuresSchema = z.object({
  /** Students may enroll themselves in free published courses. */
  selfEnrollment: z.boolean(),
  /** Paid courses can be bought through checkout. */
  payments: z.boolean(),
  /** AI assistance (summaries, feedback drafts). Off by default: schools opt in. */
  ai: z.boolean(),
});

export type Branding = z.infer<typeof brandingSchema>;
export type Features = z.infer<typeof featuresSchema>;
export interface TenantSettings {
  branding: Branding;
  features: Features;
}

export const DEFAULT_FEATURES: Features = { selfEnrollment: false, payments: false, ai: false };

const storedSettingsSchema = z.object({
  branding: brandingSchema.catch({}).default({}),
  features: featuresSchema.partial().catch({}).default({}),
});

/**
 * Reads settings stored as JSON. Lenient on purpose: a malformed or outdated value degrades to
 * defaults instead of failing every request for that school.
 */
export function readSettings(stored: unknown): TenantSettings {
  const parsed = storedSettingsSchema.safeParse(stored ?? {});
  const value = parsed.success ? parsed.data : { branding: {}, features: {} };
  return { branding: value.branding, features: { ...DEFAULT_FEATURES, ...value.features } };
}
