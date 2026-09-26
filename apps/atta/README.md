# Atta

Leafcutter ant: role division, optimized routes, underground inventory
with no margin for error. This is Canopy's first commercial system.

| Path                 | Package                       | Role                                       |
| -------------------- | ----------------------------- | ------------------------------------------ |
| `package.json`       | `@atta/product`               | Product SemVer source of truth             |
| `mise.toml`          | —                             | Daily tasks (`mise :dev`)                  |
| `docker-compose.yml` | —                             | Local Postgres, RabbitMQ, MinIO, Caddy     |
| `Caddyfile`          | —                             | `app.atta.dev` / `media.atta.dev`          |
| `.env.example`       | —                             | Product dotenv (`ENV_FILE=apps/atta/.env`) |
| `backend/`           | `@atta/backend`               | Go module `github.com/atta`                |
| `pwa/`               | `@atta/pwa`                   | Angular app (PWA)                          |
| `e2e/`               | `@atta/e2e`                   | Playwright                                 |
| `deploy/`            | `@atta/infra`, `@atta/onprem` | AWS Lambda + on-prem fleet                 |
| `desktop/`           | —                             | Planned Electron wrapper                   |
| `mobile/`            | —                             | Planned Capacitor / native shells          |

Product version: bump `@atta/product`, then
`mise //apps/atta:version:sync`. Details:
[Product versioning](../../docs/technical/architecture/product-versioning.md).

Local URLs: `https://app.atta.dev`, `https://media.atta.dev`.

Daily commands (from Canopy root): `mise //apps/atta:dev`,
`mise //apps/atta:test:full`. From this directory: `mise :dev`.

Etymology: [Naming](../../docs/product/naming.md).
