import { z } from 'zod';

/** Non-secret SSO settings, stored in integrations.config for provider "oidc". */
export const oidcConfigSchema = z.object({
  issuer: z.url(),
  clientId: z.string().min(1),
  /** Only identities with a verified email in these domains may sign in (e.g. "lincoln.edu"). */
  allowedEmailDomains: z
    .array(
      z
        .string()
        .toLowerCase()
        .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/),
    )
    .min(1),
  /** Create an account on first SSO login (just-in-time provisioning). */
  jitProvisioning: z.boolean().default(true),
  /** Role key given to accounts created by JIT provisioning. */
  defaultRoleKey: z.string().default('student'),
  /** Label for the login page's SSO button. */
  displayName: z.string().default('Sign in with your school account'),
});
export type OidcConfig = z.infer<typeof oidcConfigSchema>;

/** Secret settings, stored encrypted in integrations.credentials_enc. */
export const oidcCredentialsSchema = z.object({ clientSecret: z.string().min(1) });
export type OidcCredentials = z.infer<typeof oidcCredentialsSchema>;

/** Binds an integration's ciphertext to its tenant and provider (see lib/crypto/encryption.ts). */
export const integrationSecretsContext = (tenantId: string, provider: string) =>
  `integration:${tenantId}:${provider}`;
