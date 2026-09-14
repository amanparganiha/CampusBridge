# CampusBridge

A production-grade, multi-tenant REST API for schools: courses, sections, enrollments, grades,
payments, and integrations with campus systems, identity providers, storage, email and AI.

The focus is on the parts that are hard to get right in B2B SaaS:

- **Tenant isolation in depth.** Composite tenant foreign keys, a Prisma extension that scopes
  every query, and PostgreSQL row-level security as an independent second layer. Each layer is
  covered by its own tests.
- **Auth and access control.** Password and OIDC SSO login, short-lived JWTs, rotating refresh
  tokens with reuse detection, RBAC combined with attribute-based ownership rules, and audit logs.
- **Reliable integrations.** Stripe (idempotent webhooks), S3 presigned uploads, email, a
  mock Canvas/Moodle roster sync, OpenAI, and signed outgoing webhooks. Background work runs
  through BullMQ with an outbox for reliable delivery.
- **Operability.** Structured logs, traces, metrics, CI/CD, and Terraform for AWS.

> Status: under active construction, built phase by phase. Detailed architecture docs, ADRs
> and runbooks land in `docs/`.

## Quick start

Requirements: Node 24, Docker Desktop.

```bash
cp .env.example .env
npm install            # also generates the Prisma client
npm run infra:up       # Postgres, Redis, Mailpit, MinIO, Keycloak
npm run db:setup       # migrations (as schema owner) + least-privilege login roles
npm run db:seed        # two demo schools: Lincoln High School and Riverside University
npm run dev            # API on http://localhost:4000, docs at /docs
npm test               # unit + integration tests (integration tests need Docker)
```

Demo accounts (password `Password123!`): `admin@lincoln.test`, `maya.patel@lincoln.test`
(instructor), `jordan.lee@lincoln.test` (student), `admin@riverside.test`,
`sam.rivera@riverside.test` (instructor), `alex.chen@riverside.test` (student).

Provision another school (an operator action, deliberately not an API endpoint):

```bash
npm run tenant:create -- --slug hillcrest --name "Hillcrest Academy" \
  --admin-email admin@hillcrest.test --admin-name "Hillcrest Admin"
```

| Service       | URL                                                   |
| ------------- | ----------------------------------------------------- |
| API           | http://localhost:4000 (OpenAPI UI at `/docs`)         |
| Health        | `/health/live`, `/health/ready`                       |
| Metrics       | `/metrics` (Bearer `METRICS_TOKEN`)                   |
| Postgres      | `localhost:5433` (owner `campusbridge`, app `cb_app`) |
| Redis         | `localhost:6379`                                      |
| Mailpit (UI)  | http://localhost:8025                                 |
| MinIO console | http://localhost:9001                                 |
| Keycloak      | http://localhost:8080 (admin / admin)                 |

## Tenant isolation

Every school's data lives in shared tables, and three independent layers keep it apart:

1. **Schema.** Every tenant-owned table carries `tenant_id`; relations are composite
   `(tenant_id, …)` foreign keys, so a row cannot reference another school's row, even when
   written by a privileged role. Every unique constraint includes `tenant_id`, so uniqueness
   checks never reveal what exists at another school.
2. **Application.** Feature code only gets `TenantDb`, a Prisma client extension that injects the
   current tenant into every filter and every new row, rejects mismatched tenant ids, and fails
   closed when no tenant is in context.
3. **Database.** PostgreSQL row-level security on every tenant-owned table. The API connects as a
   role without `BYPASSRLS`, and each transaction is bound to one tenant, so even raw SQL or a
   forgotten filter cannot cross schools.

The integration suite exercises each layer on its own (including RLS with the extension switched
off), and schema-guard tests fail the build if a new table ships without its policies, with a
global unique index, or with a single-column foreign key.

## Authentication and access control

- **Password sign-in** (`POST /api/v1/auth/login`) returns a 15-minute ES256 access token and
  a refresh token. Browsers receive the refresh token as an HttpOnly, SameSite=Strict cookie,
  one per school, so the admin app can hold sessions at several schools at once.
- **Refresh tokens rotate** on every use. Replaying an already-used token revokes the whole
  session (a copied token is assumed stolen). Logout is immediate, including for access tokens.
- **Institutional SSO** (OpenID Connect with PKCE, state and nonce), configured per school.
  Accounts are created on first login for allowed, verified email domains. Try it with the seed:
  open `http://localhost:4000/api/v1/auth/oidc/lincoln/authorize` and sign in to Keycloak as
  `sso.teacher@lincoln.test` / `Password123!`.
- **RBAC plus ownership rules.** Permissions come from roles, and attribute-based rules narrow
  them (instructors manage only their own courses, students see only courses they're enrolled in).
- **Partner API keys** (`cbk_…`) carry a subset of their creator's permissions and never more.
- **Secure by default.** Every `/api/v1` route requires credentials unless it explicitly opts
  out. A test walks the OpenAPI document and fails if any route is public without review.
- Password guessing is throttled per school and email, and responses never reveal whether an
  account exists.

## Conventions at a glance

- **Errors** are RFC 9457 `application/problem+json` with a stable machine-readable `code` and
  the `requestId` for log correlation. Unexpected errors never leak internal messages.
- **Pagination** is cursor-based (`limit`, opaque `cursor`), returning `{ data, pageInfo }`.
- **Database access** uses least-privilege roles: migrations run as the schema owner, the API
  connects as `cb_app` (DML only, RLS enforced). Role passwords are set as SCRAM verifiers, so
  plaintext never reaches Postgres logs or `pg_stat_statements`.

## Repository layout

```
apps/api            Fastify API (and, later, the background worker)
  prisma/           schema, SQL migrations (RLS, roles, grants, constraints), seed
  scripts/          operator CLIs (db-bootstrap, create-tenant)
  src/              app factory, plugins, modules; src/db holds the tenant isolation layer
  test/             unit tests and Testcontainers-backed integration tests
infra/docker        Local infrastructure config (Postgres init, Keycloak realms)
.github/workflows   CI (quality, integration, migrations)
```
