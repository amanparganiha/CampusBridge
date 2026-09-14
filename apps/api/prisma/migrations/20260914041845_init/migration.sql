-- ─── Runtime roles ─────────────────────────────────────────────────────────────────────────
-- Migrations run as the schema owner. The application never connects as the owner: it uses
-- LOGIN users created per environment by scripts/db-bootstrap.ts, which are members of these
-- NOLOGIN group roles. Privileges are granted to the groups, so rotating or adding login
-- users never touches the schema.
--   cb_app_rw     API + worker job handlers. DML only; row-level security always applies.
--   cb_system_rw  Worker outbox relay and scanners. Cross-tenant access via explicit policies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cb_app_rw') THEN
    CREATE ROLE cb_app_rw NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cb_system_rw') THEN
    CREATE ROLE cb_system_rw NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO cb_app_rw, cb_system_rw;

-- Every table and sequence created by this and later migrations gets DML grants automatically.
-- Tables that need narrower access (e.g. append-only audit logs) revoke it explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cb_app_rw, cb_system_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cb_app_rw, cb_system_rw;

-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('active', 'suspended');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'active',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- ─── Tenants: integrity and privileges ──────────────────────────────────────────────────────
-- Slugs appear in URLs and SSO redirects: lowercase DNS-label style, 2-63 characters.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_slug_format"
    CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$'),
  ADD CONSTRAINT "tenants_name_not_blank"
    CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "tenants_settings_is_object"
    CHECK (jsonb_typeof("settings") = 'object');

-- Tenants are provisioned and removed by operators (scripts/create-tenant.ts), never through
-- the API, so the runtime role may only read and update them.
REVOKE INSERT, DELETE ON "tenants" FROM cb_app_rw;
