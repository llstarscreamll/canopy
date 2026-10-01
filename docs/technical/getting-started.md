# Getting started

This repo is **Canopy** (habitat monorepo). The commercial product is
**Atta** (`apps/atta`). See [Naming](../product/naming.md) and
[Monorepo layout](./architecture/monorepo.md).

## Requirements

- mise
- Docker
- Caddy (via Docker Compose)
- AWS CLI (deploy only)

Pinned in `.mise.toml`: Node `24`, Go `1.25`, pnpm `11.5`, Air `latest`.

## Setup

`mise` must already be on your `PATH`. Then run the local setup script
(idempotent):

```bash
pnpm run setup:local
```

If `pnpm` is not available yet, invoke the script directly:

```bash
./scripts/setup-local.sh
```

`setup:local` / `scripts/setup-local.sh`:

1. Installs the mise toolchain from `.mise.toml` (`node`, `go`, `pnpm`,
   `air`).
2. Runs `pnpm install` for the workspace.
3. Installs agent skills and MCP CLIs documented in
   [Development quality](./quality/development-quality.md).
4. Verifies project MCP registration files (`.cursor/mcp.json`,
   `opencode.json`).

After setup, copy env/secrets as described below, then start Atta with
`mise //apps/atta:dev` (or `mise :dev` from `apps/atta`).

## Environment

### Product dotenv (`apps/<product>/`)

Each commercial system owns its env files. `ENV_FILE` selects which
dotenv to load. Relative paths resolve from the Canopy repo root, not
from the current package. Loaders (`scripts/with-env.sh`, Playwright,
Pulumi) apply that file with override so a parent shell cannot leak
another product's values.

Default: `apps/atta/.env`. Put product secrets under `apps/atta/` — not
in a Canopy-root `.env`.

| File                           | Use for                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `apps/atta/.env`               | Daily local stack (`mise //apps/atta:dev`), ad-hoc e2e against that stack      |
| `apps/atta/.env.test`          | `mise //apps/atta:test:full` only. Copied from `.env.test.example` if missing. |
| `apps/atta/.env.deploy`        | `mise //apps/atta:deploy*` (Pulumi AWS + on-prem fleet operator vars)          |
| `apps/atta/deploy/onprem/.env` | Per client VM Compose secrets. Not loaded by `ENV_FILE`.                       |

1. Copy `apps/atta/.env.example` → `apps/atta/.env`.
2. For local API: keep `DEPLOYMENT_TARGET=onprem` and
   `RABBITMQ_URL=amqp://atta:atta@localhost:5672/`. Local DB user/db is
   `atta`.
3. Provide secrets (`GEMINI_API_KEY`, `INBOX_CREDENTIALS_ENCRYPTION_KEY`,
   `TENANT_SECRETS_ENCRYPTION_KEY`, `DATABASE_URL`, `S3_BUCKET_NAME`).
4. For AWS/Pulumi or on-prem fleet deploy: copy
   `apps/atta/.env.deploy.example` → `apps/atta/.env.deploy` and set
   `ENV`, `AWS_ACCOUNT_ID`, `AWS_REGION=us-east-1`, `ROOT_DOMAIN`,
   Cloudflare, Neon (`NEON_API_KEY`, `NEON_PROJECT_ID`), Gemini,
   `SUPPORT_EMAIL`, and (for fleet) `ONPREM_RELEASE` /
   `ONPREM_SSH_KEY_PATH`. Create the Neon project in the Console before
   the first apply. Do not put local MinIO dummy
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `.env.deploy` — use
   SSO, `~/.aws/credentials`, or CI OIDC. See
   [AWS deploy](./deployment/aws.md).

Typical local backend values:

- `DEPLOYMENT_TARGET=onprem`
- `RABBITMQ_URL=amqp://atta:atta@localhost:5672/`
- `MINIO_ENDPOINT_URL=http://localhost:9000`
- `AWS_ACCESS_KEY_ID=atta` / `AWS_SECRET_ACCESS_KEY=attasecret`
- `S3_BUCKET_NAME=atta-local-bucket`
- `S3_PRESIGN_ENDPOINT_URL=https://media.atta.dev`
- `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` /
  `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required` (MinIO SDK
  compatibility)

For raw Go commands from `apps/atta/backend`:

```bash
../../../scripts/with-env.sh go test ./...
ENV_FILE=apps/atta/.env.test ../../../scripts/with-env.sh go test ./...
```

Deployment artifacts live under `apps/atta/deploy/`. AWS Pulumi and the
on-prem fleet are parallel tracks (`mise //apps/atta:deploy` runs both).
Pulumi project: `atta` (on-prem: `atta-onprem`). SSM path
`/atta/${ENV}/secrets`. EventBridge source prefix `atta.`. On-prem
images: `atta-onprem-app` / `atta-onprem-caddy`; default remote dir
`/opt/atta`. Fleet inventory: `apps/atta/deploy/onprem/hosts.json`
(gitignored).

## Local DNS and HTTPS

Add to `/etc/hosts`:

```text
127.0.0.1   app.atta.dev
127.0.0.1   media.atta.dev
```

Point Google/Microsoft OAuth redirect URIs at `https://app.atta.dev`.

Caddy (Compose) uses `network_mode: host` and proxies:

- `app.atta.dev` → Angular `:4200`
- `app.atta.dev/api*` → Go API `:8080`
- `media.atta.dev` → MinIO `:9000`

Host networking is required on Linux so Caddy can reach those host
ports. A bridged `host.docker.internal` hop is dropped by UFW/nftables
and the browser shows **502**.

### Trust the local CA

**macOS:**

```bash
docker cp atta-caddy:/data/caddy/pki/authorities/local/root.crt ./atta-local-ca.crt
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ./atta-local-ca.crt
```

**Arch Linux:**

```bash
docker cp atta-caddy:/data/caddy/pki/authorities/local/root.crt ./atta-local-ca.crt
sudo trust anchor --store ./atta-local-ca.crt
```

Equivalent with the CA bundle files:

```bash
sudo cp ./atta-local-ca.crt /etc/ca-certificates/trust-source/anchors/
sudo update-ca-trust
```

**Chromium / Chrome on Arch:** also import into the NSS DB (Chromium does not always use the system store):

```bash
sudo pacman -S --needed nss
mkdir -p ~/.pki/nssdb
certutil -d sql:$HOME/.pki/nssdb -N --empty-password || true
certutil -d sql:$HOME/.pki/nssdb -D -n "Caddy Local Authority - ECC Root" || true
certutil -d sql:$HOME/.pki/nssdb -A -n "Caddy Local Authority - ECC Root" -t "C,," -i ./atta-local-ca.crt
```

Restart the browser after importing.

**Fedora:**

```bash
docker cp atta-caddy:/data/caddy/pki/authorities/local/root.crt ./atta-local-ca.crt
sudo cp ./atta-local-ca.crt /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust
```

**Chrome Flatpak on Fedora:** also import into the Flatpak NSS DB:

```bash
sudo dnf install -y nss-tools
docker cp atta-caddy:/data/caddy/pki/authorities/local/root.crt /tmp/caddy-root.crt
mkdir -p ~/.var/app/com.google.Chrome/.pki/nssdb
certutil -d sql:$HOME/.var/app/com.google.Chrome/.pki/nssdb -N --empty-password || true
certutil -d sql:$HOME/.var/app/com.google.Chrome/.pki/nssdb -D -n "Caddy Local Authority - ECC Root" || true
certutil -d sql:$HOME/.var/app/com.google.Chrome/.pki/nssdb -A -n "Caddy Local Authority - ECC Root" -t "C,," -i /tmp/caddy-root.crt
flatpak kill com.google.Chrome && flatpak run com.google.Chrome
```

If volumes were wiped, Caddy may regenerate the CA — re-export and re-trust. Firefox: import the cert under Settings → Certificates → Authorities.

## Dev

Product tasks live in `apps/atta/mise.toml`. From anywhere in the repo:

```bash
mise //apps/atta:dev
```

From `apps/atta`:

```bash
mise :dev
```

Both load `apps/atta/.env` via `ENV_FILE`.

Starts Postgres, RabbitMQ, MinIO, Caddy, Go API (Air), PWA, and backend
workers (`relay`, `events-consumer`, `jobs-consumer`, `scheduler`). All
backend processes use **Air** hot reload. Prefer `*.atta.dev` hosts
(cookies/routing).

Manual workers (if needed):

```bash
pnpm --filter @atta/backend dev:relay
pnpm --filter @atta/backend dev:events-consumer
pnpm --filter @atta/backend dev:jobs-consumer
pnpm --filter @atta/backend dev:scheduler
```

See [Runtime profiles](./architecture/runtime-profiles.md) and [Outbox relay](./architecture/outbox-relay.md).

- App: `https://app.atta.dev`
- Tenant example: `https://app.atta.dev/acme/dashboard`
- API: `https://app.atta.dev/api/v1/...` (`/api/health` on the same host)
- Media: `https://media.atta.dev/atta-local-bucket/<key>`

`infra:up` / `dev` wait on healthchecks (Postgres, RabbitMQ, MinIO,
Caddy 80/443) and bootstrap the MinIO bucket.

## Full test loop

```bash
mise //apps/atta:test:full
```

Canonical command for the entire local test suite (agents and humans).

Prerequisites: `mise install`, Docker, `/etc/hosts` entries for
`app.atta.dev`, and **no** running `mise //apps/atta:dev` (the script
aborts if the API is already up).

This is the deterministic local suite. It:

1. Ensures `apps/atta/.env.test` exists (copies `.env.test.example` if
   needed).
2. Deletes the Postgres Docker volume (local DB data is destroyed).
3. Starts infra, migrates, and seeds `acme`.
4. Runs Go tests (`go test ./...`) and PWA unit tests.
5. Starts API/PWA/workers, waits for health, installs Playwright Chromium.
6. Runs Playwright e2e (`desktop-chromium` + `http` projects only; WebKit
   skipped — use `mise //apps/atta:test:e2e:install:all && mise //apps/atta:test:e2e`
   for the full browser matrix).

Success: exit code **0** and `[test:full] Done`.

The script is `apps/atta/scripts/test-full.sh`. `pnpm run test` does
**not** reset the database and does **not** run e2e.

List product tasks with `mise tasks --all`. From `apps/atta`, `mise :dev`
is the same as `mise //apps/atta:dev`.

## E2E against local, staging, or production

Playwright uses one origin group. Unset values default to local
(`https://app.atta.dev` for the PWA and API,
`https://media.atta.dev` for media). Point the same variables at
another environment to run the suite there.

| Variable             | Origin                            |
| -------------------- | --------------------------------- |
| `E2E_BASE_URL`       | PWA                               |
| `E2E_API_BASE_URL`   | API (same host as PWA by default) |
| `E2E_MEDIA_BASE_URL` | Media                             |

If `E2E_BASE_URL` is an `app.*` host, the API origin is that same host
unless you set `E2E_API_BASE_URL`. Media is derived by swapping the
first label unless you set `E2E_MEDIA_BASE_URL`.

```bash
mise //apps/atta:test:e2e
E2E_BASE_URL=https://app.staging.money-path.co mise //apps/atta:test:e2e
E2E_BASE_URL=https://app.money-path.co \
  E2E_MEDIA_BASE_URL=https://media.money-path.co \
  mise //apps/atta:test:e2e
```

Auth-setup tests call `/api/v1/auth/register-local`. That endpoint is only
enabled when the target backend is in `local` mode.

## Commands

Habitat: `setup:local` · `pnpm run build` · `test` · `lint` · `format`

Atta (`apps/atta/mise.toml`): `mise //apps/atta:dev` · `test:full` ·
`infra:up` · `infra:down` · `deploy` · `deploy:aws` · `deploy:onprem`

CI and AWS deploy from GitHub:
[GitHub setup (CI and staging deploy)](./deployment/github-actions.md).

Also: [Development quality](./quality/development-quality.md) ·
[CodeGraph](./tooling/codegraph.md) · [MinIO](./tooling/minio.md)
