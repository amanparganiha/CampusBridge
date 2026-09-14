-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('invited', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "auth_method" AS ENUM ('password', 'oidc', 'invitation');

-- CreateEnum
CREATE TYPE "course_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "enrollment_status" AS ENUM ('pending_payment', 'active', 'dropped', 'completed');

-- CreateEnum
CREATE TYPE "enrollment_source" AS ENUM ('admin', 'self', 'payment', 'sync');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('user', 'api_key', 'system');

-- CreateTable
CREATE TABLE "permissions" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT,
    "status" "user_status" NOT NULL DEFAULT 'active',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("tenant_id","role_id","permission_key")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("tenant_id","user_id","role_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "auth_method" "auth_method" NOT NULL,
    "ip" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by_id" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "created_by_id" UUID,
    "last_used_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "course_status" NOT NULL DEFAULT 'draft',
    "price_cents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "owner_id" UUID NOT NULL,
    "summary" TEXT,
    "external_source" TEXT,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "term" TEXT,
    "instructor_id" UUID,
    "capacity" INTEGER,
    "enrolled_count" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "external_source" TEXT,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "enrollment_status" NOT NULL DEFAULT 'active',
    "source" "enrollment_source" NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "dropped_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grades" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "score" DECIMAL(7,2) NOT NULL,
    "max_score" DECIMAL(7,2) NOT NULL,
    "feedback" TEXT,
    "graded_by_id" UUID,
    "graded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "grades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" INET,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER,
    "response_body" JSONB,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_id_key" ON "users"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "user_identities_tenant_id_user_id_idx" ON "user_identities"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_tenant_id_issuer_subject_key" ON "user_identities"("tenant_id", "issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_id_key" ON "roles"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_key_key" ON "roles"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "user_roles_tenant_id_role_id_idx" ON "user_roles"("tenant_id", "role_id");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_user_id_idx" ON "sessions"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tenant_id_id_key" ON "sessions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenant_id_session_id_idx" ON "refresh_tokens"("tenant_id", "session_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tenant_id_token_hash_key" ON "refresh_tokens"("tenant_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_tenant_id_id_key" ON "api_keys"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_tenant_id_key_hash_key" ON "api_keys"("tenant_id", "key_hash");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_email_idx" ON "invitations"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tenant_id_id_key" ON "invitations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tenant_id_token_hash_key" ON "invitations"("tenant_id", "token_hash");

-- CreateIndex
CREATE INDEX "courses_tenant_id_owner_id_idx" ON "courses"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "courses_tenant_id_status_idx" ON "courses"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenant_id_id_key" ON "courses"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenant_id_code_key" ON "courses"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenant_id_external_source_external_id_key" ON "courses"("tenant_id", "external_source", "external_id");

-- CreateIndex
CREATE INDEX "sections_tenant_id_course_id_idx" ON "sections"("tenant_id", "course_id");

-- CreateIndex
CREATE INDEX "sections_tenant_id_instructor_id_idx" ON "sections"("tenant_id", "instructor_id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_tenant_id_id_key" ON "sections"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_tenant_id_external_source_external_id_key" ON "sections"("tenant_id", "external_source", "external_id");

-- CreateIndex
CREATE INDEX "enrollments_tenant_id_student_id_idx" ON "enrollments"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_tenant_id_id_key" ON "enrollments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_tenant_id_section_id_student_id_key" ON "enrollments"("tenant_id", "section_id", "student_id");

-- CreateIndex
CREATE INDEX "grades_tenant_id_enrollment_id_idx" ON "grades"("tenant_id", "enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "grades_tenant_id_id_key" ON "grades"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_resource_type_resource_id_idx" ON "audit_logs"("tenant_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_actor_id_idx" ON "audit_logs"("tenant_id", "actor_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_action_idx" ON "audit_logs"("tenant_id", "action");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_tenant_id_id_key" ON "audit_logs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_tenant_id_id_key" ON "outbox_events"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_principal_id_key_key" ON "idempotency_keys"("tenant_id", "principal_id", "key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_session_id_fkey" FOREIGN KEY ("tenant_id", "session_id") REFERENCES "sessions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_tenant_id_owner_id_fkey" FOREIGN KEY ("tenant_id", "owner_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_tenant_id_course_id_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "courses"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_tenant_id_instructor_id_fkey" FOREIGN KEY ("tenant_id", "instructor_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_tenant_id_section_id_fkey" FOREIGN KEY ("tenant_id", "section_id") REFERENCES "sections"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_tenant_id_enrollment_id_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "enrollments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══ Tenant isolation: row-level security ═══════════════════════════════════════════════════
-- Second, independent layer beneath the Prisma tenant extension: even a query that forgets its
-- tenant filter (or raw SQL) only ever sees the tenant bound to the current transaction.
--
-- RLS is ENABLEd, not FORCEd: the table owner is the migration role, which legitimately needs
-- cross-tenant access for schema changes and backfills. The runtime roles are separate
-- non-owner roles without BYPASSRLS (asserted by the schema-guard tests).

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO cb_app_rw, cb_system_rw;

-- The tenant bound to the current transaction via set_config('app.tenant_id', <id>, true).
-- NULLIF maps "never set" and "reset to empty" to NULL, so a missing context matches no rows
-- (fail closed) instead of raising a cast error.
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Applies the standard policy pair to a tenant-owned table. Every migration that adds a
-- tenant-owned table must call it; a test fails for any tenant_id table left uncovered.
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(target regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO cb_app_rw '
    'USING (tenant_id = app.current_tenant_id()) '
    'WITH CHECK (tenant_id = app.current_tenant_id())',
    target);
  EXECUTE format(
    'CREATE POLICY system_access ON %s AS PERMISSIVE FOR ALL TO cb_system_rw '
    'USING (true) WITH CHECK (true)',
    target);
END
$$;

SELECT app.enable_tenant_rls(table_name::regclass)
FROM unnest(ARRAY[
  'users', 'user_identities', 'roles', 'role_permissions', 'user_roles', 'sessions',
  'refresh_tokens', 'api_keys', 'invitations', 'courses', 'sections', 'enrollments', 'grades',
  'audit_logs', 'outbox_events', 'idempotency_keys'
]) AS table_name;

-- A tenant can see and update only its own row; it can never list other tenants.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON "tenants" AS PERMISSIVE FOR ALL TO cb_app_rw
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());
CREATE POLICY system_access ON "tenants" AS PERMISSIVE FOR ALL TO cb_system_rw
  USING (true) WITH CHECK (true);

-- Exact-slug lookup for unauthenticated flows (login, SSO start, login-page branding).
-- SECURITY DEFINER runs as the owner, so it works without a tenant context, but it exposes one
-- tenant's public fields per call and cannot enumerate tenants. search_path is pinned so the
-- function cannot be hijacked by objects in other schemas.
CREATE OR REPLACE FUNCTION app.resolve_tenant(p_slug text)
  RETURNS TABLE (id uuid, slug text, name text, status tenant_status, branding jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT t.id, t.slug, t.name, t.status, COALESCE(t.settings -> 'branding', '{}'::jsonb)
    FROM public.tenants t
    WHERE t.slug = lower(p_slug)
  $$;
REVOKE ALL ON FUNCTION app.resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_tenant(text) TO cb_app_rw, cb_system_rw;

-- ═══ Privileges ══════════════════════════════════════════════════════════════════════════════
-- The permission catalog is reference data managed by migrations only.
REVOKE INSERT, UPDATE, DELETE ON "permissions" FROM cb_app_rw, cb_system_rw;
-- Audit logs are append-only for every runtime role. Retention is an operator task.
REVOKE UPDATE, DELETE ON "audit_logs" FROM cb_app_rw, cb_system_rw;

-- ═══ Integrity rules the ORM cannot express ════════════════════════════════════════════════
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email")),
  ADD CONSTRAINT "users_email_format" CHECK ("email" ~ '^[^@\s]+@[^@\s]+$'),
  ADD CONSTRAINT "users_name_not_blank" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "users_failed_login_count_nonnegative" CHECK ("failed_login_count" >= 0);

ALTER TABLE "roles"
  ADD CONSTRAINT "roles_key_format" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');

ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_email_lowercase" CHECK ("email" = lower("email"));

ALTER TABLE "courses"
  ADD CONSTRAINT "courses_code_format" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  ADD CONSTRAINT "courses_title_not_blank" CHECK (length(btrim("title")) > 0),
  ADD CONSTRAINT "courses_price_nonnegative" CHECK ("price_cents" IS NULL OR "price_cents" >= 0),
  ADD CONSTRAINT "courses_currency_format" CHECK ("currency" ~ '^[a-z]{3}$'),
  ADD CONSTRAINT "courses_external_ref_pair"
    CHECK (("external_source" IS NULL) = ("external_id" IS NULL));

-- Capacity is enforced by an atomic conditional increment in the service; this CHECK is the
-- last line of defence against overbooking if that logic ever regresses.
ALTER TABLE "sections"
  ADD CONSTRAINT "sections_capacity_positive" CHECK ("capacity" IS NULL OR "capacity" > 0),
  ADD CONSTRAINT "sections_enrolled_count_within_capacity"
    CHECK ("enrolled_count" >= 0 AND ("capacity" IS NULL OR "enrolled_count" <= "capacity")),
  ADD CONSTRAINT "sections_schedule_order"
    CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" < "ends_at"),
  ADD CONSTRAINT "sections_external_ref_pair"
    CHECK (("external_source" IS NULL) = ("external_id" IS NULL));

ALTER TABLE "grades"
  ADD CONSTRAINT "grades_score_range"
    CHECK ("score" >= 0 AND "max_score" > 0 AND "score" <= "max_score");

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_action_format"
    CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_type_format"
    CHECK ("type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT "outbox_events_attempts_nonnegative" CHECK ("attempts" >= 0);

-- The relay polls unpublished events oldest-first (UUIDv7 ids are time-ordered). Published rows
-- drop out of this partial index, so it stays small no matter how large the table grows.
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" ("id") WHERE "published_at" IS NULL;

-- ═══ Permission catalog (mirrors src/authz/permissions.ts) ═════════════════════════════════
INSERT INTO "permissions" ("key", "description") VALUES
  ('tenant:read', 'View the school profile and settings'),
  ('tenant:update', 'Update the school profile, branding and settings'),
  ('user:read', 'View users'),
  ('user:invite', 'Invite users'),
  ('user:update', 'Update and suspend users'),
  ('role:read', 'View roles and their permissions'),
  ('role:assign', 'Assign and remove user roles'),
  ('apikey:manage', 'Create and revoke API keys'),
  ('course:read', 'View courses and sections'),
  ('course:create', 'Create courses'),
  ('course:update', 'Update courses and manage their sections'),
  ('course:delete', 'Archive or delete courses'),
  ('enrollment:read', 'View enrollments'),
  ('enrollment:manage', 'Enroll students and change enrollment status'),
  ('enrollment:self', 'Enroll yourself in open courses'),
  ('grade:read', 'View grades'),
  ('grade:write', 'Record and edit grades'),
  ('payment:read', 'View payments'),
  ('payment:create', 'Pay for course enrollments'),
  ('payment:refund', 'Refund payments'),
  ('file:read', 'Download course materials'),
  ('file:upload', 'Upload course materials'),
  ('integration:read', 'View integrations and sync history'),
  ('integration:manage', 'Connect, disconnect and sync integrations'),
  ('webhook:manage', 'Manage outgoing webhook endpoints'),
  ('audit:read', 'View the audit log'),
  ('audit:export', 'Export the audit log'),
  ('ai:use', 'Use AI assistance features');
