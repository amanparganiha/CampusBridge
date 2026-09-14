/*
  Drops users.locked_until: login throttling moved to Redis (per school + email), which cannot
  reveal whether an account exists. The column was never written or read.

  Deployment note: this is safe only because no deployed release references the column yet.
  In production, dropping a column must be a two-step expand/contract: first release code whose
  Prisma schema no longer has the field (Prisma selects every column by default, so old tasks
  would break mid-rollout), then drop the column in a later migration.
*/
-- CreateEnum
CREATE TYPE "integration_provider" AS ENUM ('oidc', 'canvas', 'moodle');

-- CreateEnum
CREATE TYPE "integration_status" AS ENUM ('connected', 'disconnected', 'error');

-- AlterTable
ALTER TABLE "users" DROP COLUMN "locked_until";

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "integration_provider" NOT NULL,
    "status" "integration_status" NOT NULL DEFAULT 'connected',
    "config" JSONB NOT NULL DEFAULT '{}',
    "credentials_enc" TEXT,
    "last_sync_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "connected_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integrations_tenant_id_id_key" ON "integrations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_tenant_id_provider_key" ON "integrations"("tenant_id", "provider");

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══ Row-level security ═════════════════════════════════════════════════════════════════════
SELECT app.enable_tenant_rls('integrations');

ALTER TABLE "integrations"
  ADD CONSTRAINT "integrations_config_is_object" CHECK (jsonb_typeof("config") = 'object');

-- ═══ Permissions ════════════════════════════════════════════════════════════════════════════
-- Attribute-based rules narrow course and enrollment access to what a user owns, teaches or is
-- enrolled in; these permissions lift that narrowing for administrators.
INSERT INTO "permissions" ("key", "description") VALUES
  ('course:manage_all', 'Manage every course, not only your own'),
  ('enrollment:read_all', 'View every enrollment and grade in the school');

-- Grant them to every existing school's system admin role. This data migration runs as the
-- schema owner, which is exactly why RLS is ENABLEd rather than FORCEd (see tenancy_core).
INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
CROSS JOIN (VALUES ('course:manage_all'), ('enrollment:read_all')) AS p("key")
WHERE r."key" = 'admin' AND r."is_system"
ON CONFLICT DO NOTHING;