# Deploy

AWS SaaS and on-prem client VMs are **parallel** release tracks. A
version can go to Lambda (one AWS stack) and, independently, to a pool
of client IPs. Turbo runs both `deploy` tasks at the same time.

| Track             | Path      | Tooling          | Package        | Command                          |
| ----------------- | --------- | ---------------- | -------------- | -------------------------------- |
| AWS Lambda (SaaS) | `aws/`    | Pulumi           | `@atta/infra`  | `mise //apps/atta:deploy:aws`    |
| On-prem fleet     | `onprem/` | Pulumi + Compose | `@atta/onprem` | `mise //apps/atta:deploy:onprem` |

`mise //apps/atta:deploy` runs **both** tracks. If
`apps/atta/deploy/onprem/hosts.json` is missing or empty, the on-prem track
skips.

Deploy commands load `apps/atta/.env.deploy` by default (see
`.env.deploy.example`). Backend and PWA live in `apps/atta/backend` and
`apps/atta/pwa`.

## AWS

Pulumi stack: Lambda, API Gateway, CloudFront, Cloudflare DNS, SSM.
Create the Neon project once in the Neon Console; the stack only looks it
up (`NEON_PROJECT_ID`).

```bash
cp apps/atta/.env.deploy.example apps/atta/.env.deploy
# fill ENV, AWS_ACCOUNT_ID, ROOT_DOMAIN, Cloudflare, Neon, Gemini, SUPPORT_EMAIL
mise //apps/atta:deploy:aws
```

Do not put local MinIO dummy `AWS_ACCESS_KEY_ID` in `.env.deploy`. Use
SSO or `~/.aws/credentials`. Missing stacks are created by
`pulumi stack select --create "$ENV"`.

GitHub Actions on `develop` deploys the `staging` stack via OIDC:
[GitHub setup (CI and staging deploy)](../../../docs/technical/deployment/github-actions.md).

Details: [AWS deploy](../../../docs/technical/deployment/aws.md).

## On-prem

Compose is the payload on each VM. Pulumi fans that payload out to the
host inventory (SSH, load images, `docker compose up`). Hosts apply in
parallel. Removing a host from the inventory does **not** tear down that
VM.

```bash
cp apps/atta/deploy/onprem/hosts.example.json apps/atta/deploy/onprem/hosts.json
# set ONPREM_RELEASE, ONPREM_SSH_KEY_PATH in apps/atta/.env.deploy
mise //apps/atta:deploy:onprem
```

Each VM needs Docker and `apps/atta/deploy/onprem/.env` **before** the first
fleet apply. Bootstrap one machine with Compose; after that, fleet
releases ship new image tags.

Details: [On-prem fleet](../../../docs/technical/deployment/onprem.md) and
[On-prem stack](../../../docs/technical/architecture/onprem-runtime.md).
