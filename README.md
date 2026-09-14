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
npm install
npm run infra:up      # Postgres, Redis, Mailpit, MinIO, Keycloak
npm test
```

| Service       | URL                                    |
| ------------- | -------------------------------------- |
| Postgres      | `localhost:5433` (user `campusbridge`) |
| Redis         | `localhost:6379`                       |
| Mailpit (UI)  | http://localhost:8025                  |
| MinIO console | http://localhost:9001                  |
| Keycloak      | http://localhost:8080 (admin / admin)  |

## Repository layout

```
apps/api            Fastify API and background worker
infra/docker        Local infrastructure config (Postgres init, Keycloak realms)
.github/workflows   CI
```
