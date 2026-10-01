# On-prem fleet deployment (Pulumi)

AWS SaaS (`apps/atta/deploy/aws/`) and on-prem client VMs (`apps/atta/deploy/onprem/`) are
parallel release tracks. They do not share Pulumi state. `pnpm run
deploy` runs both; use `deploy:aws` or `deploy:onprem` to run one.

Dual-runtime adapters: [Runtime profiles](../architecture/runtime-profiles.md).
VM service list: [On-prem stack](../architecture/onprem-runtime.md).

## What Pulumi does

1. Build app and Caddy images on the operator machine, tagged
   `atta-onprem-app:$ONPREM_RELEASE` and
   `atta-onprem-caddy:$ONPREM_RELEASE`.
2. For **each** host in the inventory, in parallel:
   - Copy `docker-compose.yml` and `Caddyfile` over SSH.
   - `docker save | docker load` those two images.
   - Run migrations, then `docker compose up -d --no-build`.

Postgres, RabbitMQ, and MinIO stay as upstream images on the VM.
Pulumi does **not** overwrite `apps/atta/deploy/onprem/.env` on the host
(per-client secrets).

Removing a host from the inventory is a no-op on that VM
(`retainOnDelete`).

## Inventory

Copy `apps/atta/deploy/onprem/hosts.example.json` to `apps/atta/deploy/onprem/hosts.json`
(gitignored). Override the path with `ONPREM_HOSTS_FILE`.

```json
[
  {
    "id": "acme",
    "address": "203.0.113.10",
    "user": "atta",
    "port": 22,
    "remoteDir": "/opt/atta"
  }
]
```

`id` must match `^[a-z0-9][a-z0-9-]*$`. Defaults: `user=atta`,
`port=22`, `remoteDir=/opt/atta`.

An empty or missing inventory makes `mise //apps/atta:deploy:onprem` skip
(exit 0) so AWS-only applies still work.

## Operator environment (`apps/atta/.env.deploy`)

| Variable              | Required when inventory is non-empty | Purpose                                                       |
| --------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `ONPREM_RELEASE`      | Yes                                  | Image tag (git sha or version)                                |
| `ONPREM_SSH_KEY_PATH` | Yes                                  | SSH private key for every host                                |
| `ONPREM_HOSTS_FILE`   | No                                   | Inventory path (default `apps/atta/deploy/onprem/hosts.json`) |

## Bootstrap (once per VM)

Do this before the first fleet apply:

1. Install Docker Engine and Compose v2. Open SSH for the deploy key.
2. Create `remoteDir/apps/atta/deploy/onprem/.env` from
   `apps/atta/deploy/onprem/.env.example` with **that client's** secrets.
3. Optional: run Compose once by hand to pull Postgres/RabbitMQ/MinIO.

The fleet script fails if `.env` is missing on the host.

## Release

```bash
export ONPREM_RELEASE="$(git rev-parse --short HEAD)"
export ONPREM_SSH_KEY_PATH="$HOME/.ssh/atta-onprem"
mise //apps/atta:deploy:onprem
```

Or set those in `apps/atta/.env.deploy` and run `mise //apps/atta:deploy` to ship
AWS and the fleet together.

First Pulumi stack: created automatically as `fleet` in project
`atta-onprem` (`cd apps/atta/deploy/onprem`).

## Failure behavior

Independent host resources apply in parallel. If one SSH/load/up fails,
`pulumi up` exits non-zero. Hosts that already completed keep the new
images. Re-run the same `ONPREM_RELEASE` to retry the failed hosts.

## Commands

```bash
pnpm --filter @atta/onprem lint
pnpm --filter @atta/onprem test
pnpm --filter @atta/onprem synth
mise //apps/atta:deploy:onprem
```
