# AGENTS

## Global Agent Rules & Output Style

- **Extreme Conciseness**: Be direct and extremely brief in all your responses.
- **No Conversational Filler**: Do not use preambles, postambles, or conversational phrases (e.g., "Here is the code," "I have finished," "Let me know").
- **Action-Oriented**: Focus strictly on the requested actions, tool calls, and essential explanations.
- **Output Style**: Zero yapping. Stop talking and just output the requested code, steps, or results.
- **Git Commits**: NEVER commit automatically unless explicitly requested. NEVER include co-authorship, assistance tags, or AI watermarks (e.g., "Assisted by...", "Co-authored-by...") in commit messages.
- **Documentation Style**: When writing or updating documentation, specs, or proposals, do NOT omit important details. Present them comprehensively but clearly, structurally (using lists/tables), and concisely (no fluff). For technical documentation, you must use the `docs-writer` skill.

## Toolchain and workspace

- Run `mise install` first. Versions are pinned: Node `24`, Go `1.25`, pnpm `11.5` (`.mise.toml`, `.nvmrc`, root `package.json`, `apps/atta/backend/go.mod`).
- This repo is **Canopy** (habitat). Products live under `apps/<product>/`. The current product is **Atta** (`apps/atta`). Shared TypeScript is `@canopy/*` in `packages/typescript/`. See [Naming](docs/product/naming.md).
- Use `pnpm` only. Workspace roots are `apps/*/*`, `apps/*/deploy/*`, `apps/*/deploy/aws/sdks/neon`, `packages/typescript/*`, and `infra/*` (`pnpm-workspace.yaml`), orchestrated by Turbo (`turbo.json`).
- Env files live per product under `apps/<product>/`. `ENV_FILE` is relative to the repo root. Defaults: app runtime `apps/atta/.env`; `mise //apps/atta:test:full` uses `apps/atta/.env.test`; `mise //apps/atta:deploy*` uses `apps/atta/.env.deploy`. Landing zone uses `infra/landing-zone/.env` (see [Organizations landing zone](docs/technical/deployment/organizations.md)). Loaders (`scripts/with-env.sh`, Playwright, Pulumi) honor `ENV_FILE` and override existing keys. Templates: `.env.example`, `.env.test.example`, `.env.deploy.example`. Turbo uses `envMode: loose` + `globalDependencies: ["apps/*/.env", "apps/*/.env.test", "apps/*/.env.deploy"]`. Keep `apps/atta/deploy/onprem/.env` on each client VM (Compose secrets). Do not commit `apps/atta/deploy/onprem/hosts.json`.

## Commands that matter

Product daily tasks live in `apps/<product>/mise.toml`. From anywhere:
`mise //apps/atta:<task>`. From `apps/atta`: `mise :<task>`.

- Local stack: `mise //apps/atta:dev` (loads `apps/atta/.env`, starts Atta infra + API/PWA/workers).
- **Full test suite (canonical verification)**: `mise //apps/atta:test:full`. Runs the entire local loop — wipe Postgres, load `apps/atta/.env.test`, migrate/seed, Go tests (`go test ./...`), PWA unit tests, then e2e (`desktop-chromium` + `http`; WebKit skipped). Stop `mise //apps/atta:dev` first (script fails if the API is already up). Destroys local Postgres data. **After implementing or fixing behavior, verify with this command**; do not substitute package-scoped `go test -run …` or partial e2e. Success: exit **0** and `[test:full] Done`. Script: `apps/atta/scripts/test-full.sh`. Full browser matrix (incl. WebKit): `mise //apps/atta:test:e2e:install:all` then `mise //apps/atta:test:e2e`.
- Fast unit/integration only (no DB reset, no e2e): `pnpm run test`.
- Habitat verification without e2e: `pnpm run lint && pnpm run test && pnpm run build`.
- Atta deploy: `mise //apps/atta:deploy` (AWS + on-prem in parallel; loads `apps/atta/.env.deploy`). Use `deploy:aws` / `deploy:onprem` for one track. On-prem skips if `apps/atta/deploy/onprem/hosts.json` is missing or empty.
- Backend targeted: `pnpm --filter @atta/backend dev|lint|test|build|migrate:all`.
- Backend tests: always `pnpm --filter @atta/backend test` (full `go test ./...`). Never verify with package-scoped or `-run` filtered `go test`.
- PWA targeted: `pnpm --filter @atta/pwa dev|lint|test|build`.
- E2E targeted: `pnpm --filter @atta/e2e lint|test:e2e|test:e2e:local|test:e2e:browser|test:e2e:http|test:e2e:ui`.
- AWS deploy (`apps/atta/deploy/aws`, `@atta/infra`): `pnpm --filter @atta/infra lint|test|build|synth|deploy|migrate`. `deploy` invokes the migrate Lambda when that package changes, then publishes the other Lambdas and web assets.
- On-prem fleet (`apps/atta/deploy/onprem`, `@atta/onprem`): `pnpm --filter @atta/onprem lint|test|synth|deploy`. Pulumi SSHs each inventory host and loads Compose images tagged `ONPREM_RELEASE`.
- AWS Organizations landing zone (`infra/landing-zone`, `@canopy/landing-zone`): occasional manual bootstrap — `mise //infra/landing-zone:preview|up|test`. Not wired to CI. See [Organizations landing zone](docs/technical/deployment/organizations.md).

## Backend (`apps/atta/backend`)

- Entrypoints live under `cmd/onprem/` (local + client VM) and `cmd/aws/lambda/` (AWS Lambda).
- API entrypoint is `cmd/onprem/api/main.go`; AWS HTTP is `cmd/aws/lambda/http`. Local `dev` uses Air (`.air.toml`) and loads `ENV_FILE` (default `apps/atta/.env`).
- Worker entrypoints: `cmd/onprem/relay`, `cmd/onprem/events-consumer`, `cmd/onprem/jobs-consumer`, `cmd/onprem/scheduler`. Background workers (`dev:relay`, `dev:events-consumer`, `dev:jobs-consumer`, `dev:scheduler`) use Air configs `.air.worker-*.toml` with the same reload behavior.
- AWS Lambda entrypoints: `cmd/aws/lambda/http`, `cmd/aws/lambda/outbox-relay`, `cmd/aws/lambda/eventbridge`, `cmd/aws/lambda/sqs`, `cmd/aws/lambda/scheduler`.
- Feature architecture: every bounded context is `internal/<bc>/` with this public surface:
  - `wire.go`: only Go facade other packages import (`NewApplication`, `NewHTTPHandler`, `RegisterEvents`, `RegisterJobs`, OHS constructors). Host (`cmd/*`, `platform/messaging`, `platform/http/host`) imports the module root only.
  - `api/`: Open Host Service (interfaces + DTOs) for other BCs. No `application` imports.
  - `domain/`: core business model (no infra).
  - `application/`: use cases (`commands`, `queries`), consumer `ports`, and OHS implementations.
  - `contracts/`: job/event JSON payloads only — not OHS interfaces.
  - `adapters/`: HTTP, events, jobs, repos, providers. Other BCs must not import this layer.
- Import rules: other BCs consume `{bc}/api` (and `internal/contracts/events` for platform events). Never import another BC's `application/`, `adapters/`, or `domain/`. Do not add empty `RegisterEvents`/`RegisterJobs` on modules with no consumers.
- Dependency rule inside a module: `adapters -> application -> domain`. Do not import adapters from `domain` or `application`.
- Error Handling & JSON:API: **Never** use `http.Error()`. Handlers must return `error` and be registered using `api.Wrap(handlerFunc, isDev)`.
- Domain Errors: Wrap or create errors using `appErrors.Wrap(err, appErrors.CodeX, "msg")`. `api.Wrap` automatically converts these to JSON:API payloads and injects `meta._debug` stack traces when `isDev` is true.
- Migrations CLI is `cmd/onprem/migrate/main.go`; keep migration sets split between `migrations/controlplane` and `migrations/tenant`.
- Runtime config (`internal/platform/config/config.go`):
  - `onprem` (local + client deploy): product dotenv via `ENV_FILE` (default `apps/atta/.env`) — `MINIO_ENDPOINT_URL`, `RABBITMQ_URL`, encryption keys, API keys.
  - `aws`: SSM Parameter Store SecureString JSON at `SSM_PARAMETER_NAME` (shape in [docs/technical/deployment/ssm-secrets.md](../docs/technical/deployment/ssm-secrets.md)). Loaded at Lambda boot by `config.Load()` before `platform.NewModule()`.
- Local dev object storage: MinIO in `apps/atta/docker-compose.yml` (`:9000` API, `:9001` console). Bucket bootstrap: `apps/atta/backend/scripts/init-minio.sh` via `mise //apps/atta:infra:up` (`minio-init` service).

## PWA (`apps/atta/pwa`)

- Angular standalone + zoneless app. Wiring is in `src/app/app.config.ts`, routes in `src/app/app.routes.ts`.
- Dev server: `scripts/dev.sh` wraps `ng serve --host 0.0.0.0 --port 4200` (graceful Turbo shutdown); `angular.json` only allows host `app.atta.dev`.
- Tenant routing: Tenant pages are children of the `/:tenantId` route and wrapped by `TenantLayoutComponent`.
- Tenant header is derived from the `tenantId` param via `core/interceptors/tenant.interceptor.ts`.
- Error Handling & UI Feedback: `error.interceptor.ts` globally handles JSON:API responses and logs `meta._debug` to the console.
  - **Toast (`ToastService`)**: Sonner-backed; `<hlm-toaster />` in `app.component.ts`. Use for global transient messages (5xx, network, success). The interceptor handles 5xx/network toasts automatically.
  - **Inline alerts**: Use `hlm-alert` within forms or pages for contextual 4xx validation errors.
- Auth refresh behavior is in `core/interceptors/auth.interceptor.ts` (401 -> refresh -> retry).
- Feature convention: keep business/data orchestration in `*/application/*store.ts`; keep `presentation` components thin.
- Shared cross-feature types: `ConnectionStatus` in `src/app/core/domain/connection-status.model.ts`; mail provider helpers in `src/app/inbox/domain/inbox.types.ts`.
- Shared presentation: `app-connection-status-chip` and `app-file-upload` under `src/app/core/presentation/components/`.
- `ThemeService` in `src/app/core/services/theme.service.ts` for dark-mode-aware embedded views.
- **Spartan UI**: Helm components in `src/app/shared/ui/`; icons via Lucide + `src/app/shared/icons/app-icons.ts`. See `docs/technical/frontend/spartan-ui.md`.

## E2E Testing (`apps/atta/e2e`)

- **Run the full suite with** `mise //apps/atta:test:full` — self-contained (infra reset, migrations, unit tests, dev stack for e2e, Playwright install, `test:e2e:local`). See [Getting started](docs/technical/getting-started.md#full-test-loop).
- Uses Playwright. `test:full` installs Chromium automatically; for ad-hoc e2e run `mise //apps/atta:test:e2e:install` first.
- Specs are split into two Playwright projects: `tests/browser/` (real browser) and `tests/http/` (API contracts). Shared clients/factories live in `tests/support/`.
- Default origins are local (`https://app.atta.dev` for PWA and API, `https://media.atta.dev` for MinIO). Override with `E2E_BASE_URL`, `E2E_API_BASE_URL`, and `E2E_MEDIA_BASE_URL` (see `apps/atta/.env.example`).
- Ad-hoc e2e (stack already running via `mise //apps/atta:dev`): `mise //apps/atta:test:e2e:local` (chromium + http), `mise //apps/atta:test:e2e` (all projects incl. WebKit), `mise //apps/atta:test:e2e:browser`, `mise //apps/atta:test:e2e:http`, `mise //apps/atta:test:e2e:ui` (interactive).
- To test the full auth flow, the backend must be in `local` mode so the `/api/v1/auth/register-local` endpoint is enabled.
- UI doesn't have a signup form yet, so fixtures rely on the API `registerLocalOrFail` directly for setup.

## Local infra and deploy constraints

- `apps/atta/docker-compose.yml` runs Postgres `5432`, RabbitMQ `5672`, MinIO `9000/9001`, Caddy `80/443`.
- `apps/atta/Caddyfile` maps `app.atta.dev` → Angular `:4200`, `app.atta.dev/api*` → Go API `:8080`, and `media.atta.dev` → MinIO `:9000`; use `app.atta.dev` locally for cookie/routing behavior.
- AWS Pulumi entrypoint is `apps/atta/deploy/aws/index.ts` (`@atta/infra`) and loads `apps/atta/.env.deploy`:
  - `ENV`, `AWS_ACCOUNT_ID`, `ROOT_DOMAIN`, `CLOUDFLARE_API_TOKEN`, `NEON_API_KEY`, `NEON_PROJECT_ID`, and `GEMINI_API_KEY` must be set.
  - `AWS_REGION` must be `us-east-1` (CloudFront certificates and CloudFront WAF).
  - Postgres is Neon (not RDS). DNS is Cloudflare.
- Web deploy consumes `apps/atta/pwa/dist/pwa/browser`; build PWA before AWS deploy.
- On-prem fleet: `ONPREM_RELEASE`, `ONPREM_SSH_KEY_PATH`, and `apps/atta/deploy/onprem/hosts.json` (see [On-prem fleet](docs/technical/deployment/onprem.md)). Each VM keeps its own `apps/atta/deploy/onprem/.env`.

## Hooks, formatting, and docs

- Pre-commit runs `pnpm lint-staged` then `pnpm run lint`, then optional `codegraph sync` (`.husky/pre-commit`).
- `lint-staged` applies Prettier to staged web/docs files and `gofmt -w` to staged Go files.
- Root `pnpm run format` only formats `*.{ts,tsx,md,mdx}`.
- Product/domain specs live under `.specs/features/*` in English.
- **Ubiquitous Language**: ALWAYS refer to `docs/domain/GLOSSARY.md` to map Spanish business terms (e.g., Factura, Adquirente) to their exact English counterparts for code. Keep Colombian e-invoicing acronyms (DIAN, CUFE, UBL) as-is.
