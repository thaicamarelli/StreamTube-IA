---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-14T18:52:54-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-21T20:37:36-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-14T19:09:40-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-14T19:09:40-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-14T19:09:40-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-14T19:09:40-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-14T18:52:53-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ (Clarified by the challenge brief: video UI — upload screen, player, visibility editing — is deferred; this phase is backend-only.)

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (no explicit `Subprojetos:` line in the phase-03 block; inferred from the backend-only nature of every capability bullet and confirmed by the technical-decisions doc's `_Subprojects in scope:_` note).

**Deferred subprojects:** `next-frontend/` — not initialized; video upload/playback UI deferred to Fase 05 (Página de Visualização do Vídeo).

**Sequencing notes:** `> Depende de: Fase 01, Fase 02`. Intro: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (`> Depende de: Fase 01`).
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (`> Depende de: Fase 02, Fase 03`).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Job Queue Technology | decided | A | — |
| phase-03-videos/TD-02 | phase | Backend | Object Storage Access & Bucket/Key Organization | decided | B | — |
| phase-03-videos/TD-03 | phase | Backend | Large File Upload Strategy (up to 10GB) | decided | A | — |
| phase-03-videos/TD-04 | phase | Backend | Video Processing Tooling (metadata & thumbnail) | decided | A | — |
| phase-03-videos/TD-05 | phase | Backend | Streaming & Download Delivery Strategy | decided | B | — |
| phase-03-videos/TD-06 | phase | Backend | Video Processing Status Lifecycle & Failure Handling | decided | B | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-02 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** this is a single-producer/single-consumer background job (not a cross-service messaging need, ruling out C), and the project will clearly benefit from BullMQ's built-in retry/backoff for TD-06's processing-failure handling and its official `@nestjs/bullmq` integration. The one new Redis container is a small, well-understood addition (no config needed for this use case) compared to the risk of coupling queue throughput to the primary Postgres instance (Option B) for a workload — video processing jobs — that is expected to grow with the platform.

**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** the project has no per-asset-type policy requirement yet, and co-locating a video's assets under its own UUID keeps deletion and key-collision avoidance trivial, reusing the identifier scheme the project already committed to for entities. Client library: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (AWS SDK v3) with `forcePathStyle: true`. **Chosen:** B (two buckets by asset type: `videos`, `thumbnails`) — deleting both assets for a video stays a single logical operation (one service method firing both bucket deletes in parallel via `Promise.all`, keyed by the same video UUID in each bucket).

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** it is the only option that both reaches the 10GB target and keeps bytes off the API process entirely, and it is the native, portable S3 protocol (works unchanged against real AWS S3 later). Option C's extra resumability is a genuine but non-essential upgrade this phase does not require. Depends on TD-02 (same storage client issues the presigned part URLs).

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** the "obvious" choice (`fluent-ffmpeg`) is dead and actively unsafe to adopt in a new project (archived May 2025, unmaintained); direct CLI invocation avoids that risk entirely, stays current with whatever FFmpeg version the worker image installs, and is a well-documented, standard pattern (`ffprobe -print_format json`). This also fully resolves metadata extraction and thumbnail generation together, since both are the same tool invoked two ways.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** it satisfies "streaming without full download" for free (S3-compatible storage already implements Range/206 correctly) and keeps the API off the bandwidth-heavy read path. **Chosen:** B (presigned GET redirect) with a short TTL (~15 minutes) and client-side reissue on expiry; exposure risk is bounded by the TTL and, in this phase, moot in practice — no access-control rule exists yet for the redirect to bypass (anonymous viewing is a first-class platform feature; visibility rules only arrive in Fase 04). Revisit Option A (full API proxy) if Fase 04 introduces confidentiality needs stricter than "unlisted".

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** the enum model is the minimal one that satisfies both the draft pre-registration and the processing/failure capabilities, keeping the `videos` table as the single source of truth for status queries. **Chosen:** B (status enum + `video_processing_events` audit table) — chosen over the simpler recommendation for observability into processing attempts/failures from the start.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) recommended, but decision diverged during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. PostgreSQL is already in the stack, so no new infrastructure needed.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important. The DB table is trivial to implement, decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP, works with Mailpit for local development.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project. class-validator is the documented NestJS approach, already used extensively via decorators.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes without RFC 9457 overhead. Simple `{ statusCode, error, message }` format with domain codes.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration; guard system allows scoping rate limiting per-module via `APP_GUARD`, with `@SkipThrottle()` for exemptions.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) recommended, but decision diverged — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`).

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — Strict `[a-z0-9_]` allowlist, simplest and most portable choice, with `user_<random>` fallback.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Cookie-based session (not Auth.js) — the backend is the auth authority; `next/headers` `cookies()` is the canonical primitive for Next.js 16 / React 19.

**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** `iron-session` for encrypted, httpOnly session cookie — single cookie simplifies logout and avoids orphan-cookie failure modes.

**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** Single-flight token refresh pattern, tested via MSW with concurrent-call assertions.

**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** react-hook-form + Zod resolvers — aligned with the project's shadcn form primitive and Zod-first validation pattern established in `next-frontend-config-base`.

**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Route Handlers as the single BFF mutation surface — strict-BFF alignment, reuses existing MSW test scaffold.

**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Cookie-sourced session delivered via RSC + Client Provider — no first-render flicker, no new BFF endpoint.

**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** RSC-owns-token pattern for confirmation/reset flows — first-paint-correct, single integration pattern reused across both flows.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas.

**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre a UI runtime isolada é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI").

**Libraries:** —

## Inherited Conventions

_No conventions inherited — no prior phase declares a "Conventions to Match" section in its phase doc or context.md._

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|---------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; FE confirmation flow picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | Logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout`. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent, link destination remains a 404 until a later phase. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | Umbrella bullet deferred to the phase that lands the missing confirmação/reset-password screens. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| (none yet — appended by `/plan-resolve` as capabilities are marked) | | | |

## Testing Requirements

### nestjs-project

| Artifact created | Required tests |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (queue, storage client) | Unit: real lib with test config |
| Service with side-effect dep (storage, queue publishing) | Integration: real capture service (MinIO/Redis via Compose) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard | E2E + Unit if complex internal logic |
| Exception Filter | Unit + E2E |

Notably already called out by the guide as in-scope testing criteria: "service-to-external-system contracts — local storage uploads, SMTP sends via Mailpit, **queue publishing**" and "race conditions — **concurrent video uploads**, duplicate likes/subscriptions, optimistic locking" — directly applicable to this phase's upload/queue/worker surface.
