# Monorepo layout

Canopy is a pnpm + Go workspace that hosts multiple commercial
systems. Atta is the first product. See [Naming](../../product/naming.md)
for why those names exist.

```text
canopy/
├── go.work                      # Local Go modules
├── pnpm-workspace.yaml          # Angular, deploy, TS libs
├── pkg/                         # Shared Go (extract here when stable)
├── packages/
│   ├── typescript/              # Shared Angular / TypeScript (`@canopy/*`)
│   ├── swift/                   # Shared Swift packages (iOS)
│   └── kotlin/                  # Shared Gradle builds (Android)
└── apps/
    └── atta/                    # Current commercial system
        ├── mise.toml            # Daily tasks (`mise :dev`)
        ├── docker-compose.yml   # Local Atta infra (Compose project `atta`)
        ├── Caddyfile            # app.atta.dev / media.atta.dev
        ├── .env.example         # Product dotenv template
        ├── .env.test.example    # Isolated test loop template
        ├── backend/             # Independent Go module `github.com/atta`
        │   ├── cmd/aws/lambda/  # http, sqs, eventbridge, outbox-relay, scheduler, migrate
        │   ├── cmd/onprem/      # api, relay, workers, migrate, seed
        │   └── internal/        # Atta-only bounded contexts
        ├── pwa/                 # Angular PWA (`@atta/pwa`)
        ├── e2e/                 # Playwright (`@atta/e2e`)
        ├── deploy/              # AWS Pulumi + on-prem fleet
        ├── desktop/             # Planned Electron wrapper
        └── mobile/              # Planned Capacitor / native shells
```

Future products (`threehopper`, `kinglet`, `bowerbird`, …) follow the
same `apps/<product>/` shape: backend, pwa, desktop, mobile, deploy,
plus that product's `docker-compose.yml`, `Caddyfile`, and dotenv
templates. Canopy does not own a root Compose file.

## Daily commands

Each product owns its tasks in `apps/<product>/mise.toml`. The Canopy
root keeps habitat-wide `pnpm` scripts (`lint`, `test`, `build`,
`format`) and toolchain pins.

From anywhere:

```bash
mise //apps/atta:dev
mise //apps/atta:test:full
```

From `apps/atta`:

```bash
mise :dev
mise :test:full
```

A second product adds `apps/<name>/mise.toml` and is invoked as
`mise //apps/<name>:dev`. Do not add product `dev` scripts to the Canopy
root `package.json`.

## Product env files

Each product keeps its own dotenv next to its Compose file. `ENV_FILE`
is always relative to the Canopy repo root (or an absolute path).
Loaders (`scripts/with-env.sh`, Playwright, Pulumi) override existing
keys so a parent shell cannot leak the wrong product.

| File                           | Use for                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `apps/atta/.env`               | Daily local stack (`mise //apps/atta:dev`), Pulumi, ad-hoc e2e      |
| `apps/atta/.env.test`          | `mise //apps/atta:test:full` only (copied from `.env.test.example`) |
| `apps/atta/.env.aws`           | Optional AWS deploy file (`ENV_FILE=apps/atta/.env.aws`)            |
| `apps/atta/deploy/onprem/.env` | Per client VM Compose secrets (not `ENV_FILE`)                      |

Default `ENV_FILE` is `apps/atta/.env`. Point it at another product
when that product exists, for example
`ENV_FILE=apps/threehopper/.env`.

Do not put product secrets in a Canopy-root `.env`.

## Workspace globs

- pnpm: `apps/*`, `apps/*/*`, `apps/*/deploy/*`,
  `apps/*/deploy/aws/sdks/neon`, `packages/typescript/*`
- Go: `go.work` lists each product module (`./apps/atta/backend` today)

Product roots (`apps/atta`) are workspace packages so
`@atta/product` can hold the product SemVer. See
[Product versioning](./product-versioning.md).

## What stays shared vs product-owned

| Shared (Canopy)                | Product-owned (Atta today)                           |
| ------------------------------ | ---------------------------------------------------- |
| Toolchain, Turbo, `scripts/`   | Domain, HTTP API, workers                            |
| `@canopy/system-notices`       | `@atta/pwa`, `@atta/backend`                         |
| Future `pkg/httpx`, `pkg/rbac` | Local Compose/Caddy, migrations, Pulumi, e2e, `.env` |

Do not move Atta `internal/platform` into `pkg/` until a second product
needs the same module.

## AWS and on-prem names

Atta Pulumi project: `atta` (on-prem: `atta-onprem`). Resource prefix
`${ENV}-atta`. SSM path `/atta/${ENV}/secrets`. EventBridge sources
use the `atta.` prefix. RabbitMQ topology uses `atta.events` /
`atta.jobs`.
