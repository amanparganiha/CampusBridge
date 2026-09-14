import type { PrismaClient } from '../src/generated/prisma/client.js';
import type { Encryptor } from '../src/lib/crypto/encryption.js';
import { hashPassword } from '../src/lib/password.js';
import { integrationSecretsContext } from '../src/modules/auth/oidc/oidc.config.js';
import { provisionTenant } from '../src/modules/tenants/provisioning.js';
import { DEMO_PASSWORD, SEED_TENANTS, type SeedTenant } from './seed-data.js';

export interface SeedOptions {
  /** When given, each school also gets SSO against its Keycloak realm. */
  sso?: { encryptor: Encryptor; keycloakUrl: string };
}

/** Creates one demo school and all of its people, courses, sections, enrollments and grades. */
async function seedTenant(db: PrismaClient, seed: SeedTenant, passwordHash: string): Promise<void> {
  const { tenant, roleIds } = await provisionTenant(db, {
    slug: seed.slug,
    name: seed.name,
    settings: seed.settings,
    admin: { ...seed.admin, password: DEMO_PASSWORD },
  });
  const tenantId = tenant.id;

  await db.$transaction(async (tx) => {
    const userIds = new Map<string, string>();
    const people = [
      ...seed.instructors.map((person) => ({ ...person, roleId: roleIds.instructor })),
      ...seed.students.map((person) => ({ ...person, roleId: roleIds.student })),
    ];
    for (const person of people) {
      const user = await tx.user.create({
        data: { tenantId, email: person.email, name: person.name, passwordHash, status: 'active' },
      });
      await tx.userRole.create({ data: { tenantId, userId: user.id, roleId: person.roleId } });
      userIds.set(person.email, user.id);
    }
    const idOf = (email: string): string => {
      const id = userIds.get(email);
      if (!id) throw new Error(`seed-data references unknown user ${email}`);
      return id;
    };

    for (const course of seed.courses) {
      const created = await tx.course.create({
        data: {
          tenantId,
          code: course.code,
          title: course.title,
          description: course.description,
          status: course.status,
          priceCents: course.priceCents ?? null,
          ownerId: idOf(course.ownerEmail),
        },
      });

      for (const section of course.sections) {
        const createdSection = await tx.section.create({
          data: {
            tenantId,
            courseId: created.id,
            name: section.name,
            term: section.term,
            capacity: section.capacity,
            enrolledCount: section.enrollments.length,
            instructorId: idOf(section.instructorEmail),
          },
        });

        for (const enrollment of section.enrollments) {
          const createdEnrollment = await tx.enrollment.create({
            data: {
              tenantId,
              sectionId: createdSection.id,
              studentId: idOf(enrollment.studentEmail),
              status: 'active',
              source: 'admin',
            },
          });
          for (const grade of enrollment.grades ?? []) {
            await tx.grade.create({
              data: {
                tenantId,
                enrollmentId: createdEnrollment.id,
                title: grade.title,
                score: grade.score,
                maxScore: grade.maxScore,
                feedback: grade.feedback ?? null,
                gradedById: idOf(section.instructorEmail),
              },
            });
          }
        }
      }
    }
  });
}

/** Adds SSO against the school's Keycloak realm unless the school already has SSO configured. */
async function ensureDemoSso(
  db: PrismaClient,
  tenantId: string,
  seed: SeedTenant,
  options: SeedOptions,
): Promise<void> {
  if (!options.sso) return;
  await db.integration.upsert({
    where: { tenantId_provider: { tenantId, provider: 'oidc' } },
    update: {},
    create: {
      tenantId,
      provider: 'oidc',
      config: {
        issuer: new URL(`/realms/${seed.sso.realm}`, options.sso.keycloakUrl).href,
        clientId: 'campusbridge',
        allowedEmailDomains: seed.sso.allowedEmailDomains,
        jitProvisioning: true,
        defaultRoleKey: 'student',
        displayName: `Sign in with ${seed.name} SSO`,
      },
      credentialsEnc: options.sso.encryptor.encryptJson(
        { clientSecret: seed.sso.clientSecret },
        integrationSecretsContext(tenantId, 'oidc'),
      ),
    },
  });
}

/**
 * Seeds every demo school that does not exist yet, and makes sure each has demo SSO. Runs as
 * the schema owner, like provisioning. Returns what happened per school, for the CLI to print.
 */
export async function seedDemoTenants(
  db: PrismaClient,
  options: SeedOptions = {},
  tenants: readonly SeedTenant[] = SEED_TENANTS,
): Promise<{ slug: string; created: boolean }[]> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const outcomes: { slug: string; created: boolean }[] = [];
  for (const seed of tenants) {
    const existing = await db.tenant.findUnique({ where: { slug: seed.slug } });
    if (!existing) await seedTenant(db, seed, passwordHash);
    const tenant = existing ?? (await db.tenant.findUniqueOrThrow({ where: { slug: seed.slug } }));
    await ensureDemoSso(db, tenant.id, seed, options);
    outcomes.push({ slug: seed.slug, created: !existing });
  }
  return outcomes;
}
