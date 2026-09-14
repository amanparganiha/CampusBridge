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
npm run dev            # API on http://localhost:4000, docs at /docs
npm test
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

## Conventions at a glance

- **Errors** are RFC 9457 `application/problem+json` with a stable machine-readable `code` and
  the `requestId` for log correlation. Unexpected errors never leak internal messages.
- **Pagination** is cursor-based (`limit`, opaque `cursor`), returning `{ data, pageInfo }`.
- **Database access** uses least-privilege roles: migrations run as the schema owner, the API
  connects as `cb_app` (DML only). Role passwords are set as SCRAM verifiers, so plaintext never
  reaches Postgres logs or `pg_stat_statements`.

## Repository layout

```
apps/api            Fastify API (and, later, the background worker)
  prisma/           schema and SQL migrations (roles, grants, constraints)
  scripts/          operator CLIs (db-bootstrap)
  src/              app factory, plugins, modules
infra/docker        Local infrastructure config (Postgres init, Keycloak realms)
.github/workflows   CI
```
