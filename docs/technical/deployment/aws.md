# AWS Lambda deployment (Pulumi)

Dual-runtime overview: [Runtime profiles](../architecture/runtime-profiles.md).

Pulumi program: `apps/atta/deploy/aws/` (`@atta/infra`). On-prem fleet is a
**separate** Pulumi project (`apps/atta/deploy/onprem/`) — see
[On-prem fleet](./onprem.md) and [Deploy](../../../apps/atta/deploy/README.md).

This stack deploys the **aws/lambda** target. Postgres runs on **Neon**, not
Amazon RDS. DNS is in **Cloudflare**. Application secrets live in **SSM
Parameter Store** (`SecureString`) under a customer-managed KMS key.

## Architecture

| Concern            | Service                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| PWA                | Private S3 + CloudFront (OAC, TLS 1.2+, WAF)                                                                       |
| HTTP API           | CloudFront `/api*` → API Gateway DomainName (`api.*`, default endpoint off) + Go Lambda (`provided.al2023`, arm64) |
| Jobs               | SQS + Lambda, with a 14-day DLQ                                                                                    |
| Integration events | EventBridge custom bus (`source` prefix `atta.`) + Lambda                                                          |
| Outbox relay       | EventBridge Scheduler `rate(1 minute)` → relay Lambda                                                              |
| Platform schedules | EventBridge Scheduler → scheduler Lambda (`outbox-sweeper`, `catalog-import-purge`, optional `inbox-sync-all`)     |
| Object storage     | Private S3 bucket (KMS), browser CORS for the app origin; presigns use the S3 REST endpoint                        |
| Postgres           | Neon project in `aws-us-east-1` (pooled URL for Lambdas, direct URL for migrations / `CREATE DATABASE`)            |
| Secrets            | SSM Parameter Store `SecureString` JSON, CMK                                                                       |
| DNS                | Cloudflare DNS-only CNAMEs: apex/`app.` → CloudFront; `api.` → API Gateway origin                                  |
| Observability      | CloudWatch logs (30/90 day retention), X-Ray, Lambda/SQS alarms, optional SNS email                                |

Lambdas are **not** in a VPC. Neon is reached over TLS on the public pooled
endpoint (PgBouncer). That avoids NAT Gateways and still keeps RDS out of the
design.

Outbox flow: API → Neon outbox → `outbox-relay` Lambda → EventBridge / SQS →
consumer Lambdas.

EventBridge Scheduler's minimum rate is one minute, so AWS relay ticks at
`1 minute` instead of the local 30s loop.

## Well-Architected mapping

| Pillar                 | How this stack applies it                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operational excellence | Pulumi TypeScript, tagged resources, CloudWatch alarms, X-Ray                                                                                                                                                                           |
| Security               | CMK (rotation, CloudFront OAC on the web bucket), SSM SecureString, IAM per function, S3 Block Public Access, CloudFront + API Gateway WAF (IP reputation, Common, Known Bad Inputs, SQLi), TLS 1.2+, Cloudflare DNS validation for ACM |
| Reliability            | Multi-AZ CloudFront/API Gateway/Lambda, SQS DLQ, Lambda DLQ, EventBridge Scheduler DLQ. Neon HA and PITR are set on the project in the Neon Console, not in this stack                                                                  |
| Performance            | Lambda arm64, Neon pooler for bursty connections, CloudFront cache split (hashed vs entry)                                                                                                                                              |
| Cost                   | No NAT/RDS/RDS Proxy. Non-prod Neon scale-to-zero is a Console setting (`suspendTimeout`)                                                                                                                                               |
| Sustainability         | Graviton Lambdas, serverless data plane                                                                                                                                                                                                 |

Account-level GuardDuty and CloudTrail stay outside this stack. Enable them on
the AWS account.

## Domains

Set these in `apps/atta/.env`. Cloudflare must already host `ROOT_DOMAIN`.

| Variable               | Example         | DNS record                                                                                          |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `ROOT_DOMAIN`          | `money-path.co` | Apex CNAME (Cloudflare flattening) → CloudFront                                                     |
| `APP_SUBDOMAIN`        | `app`           | `app.` → CloudFront (PWA at `/`, API at `/api`)                                                     |
| `MEDIA_SUBDOMAIN`      | `media`         | ACM SAN only (not a CloudFront alias or DNS record). Browser uploads use S3 presign + bucket CORS   |
| `API_ORIGIN_SUBDOMAIN` | `api`           | Origin-only grey-cloud CNAME → API Gateway. Not a CloudFront alias. Browser traffic stays on `app.` |

Records are **DNS-only** (`proxied: false`) so CloudFront and ACM see the
hostname. Do not orange-cloud these names.

## Secrets

See [AWS secrets](./ssm-secrets.md). Pulumi writes the JSON blob, including
Neon `database_url` (pooler) and `database_direct_url` (direct). Lambdas
receive only `SSM_PARAMETER_NAME`. At cold start, `config.Load()` decrypts
the parameter and `platform.NewModule()` wires the infrastructure layer.

Generated once and stored in Pulumi state + Parameter Store:

- JWT access/refresh secrets
- Inbox and tenant encryption keys
- Messaging attestation secret

Pass `GEMINI_API_KEY` (required), `SUPPORT_EMAIL` (required for non-local
runtimes), and optional OAuth client IDs/secrets through `apps/atta/.env`
at deploy time. Gemini/OAuth go into the SecureString parameter.
`SUPPORT_EMAIL` (and optional `TERMS_URL` / `PRIVACY_URL` /
`LICENSE_LABEL`) are written to SSM and Lambda env for about / health.

## Neon

Create the Neon project **once** in the [Neon Console](https://console.neon.tech)
(or the Neon CLI). This Pulumi program does **not** create, replace, or
delete it. `pulumi up` and `pulumi destroy` cannot drop Postgres.

Use one project per `ENV`. Recommended settings:

- Region `aws-us-east-1` (same as `AWS_REGION`)
- Postgres 16
- Default database and role `atta` (the role needs `CREATEDB` for
  tenant databases)
- Default branch named after `ENV` (`staging`, `prod`)
- Prod: protect the default branch, 7-day restore window, no scale-to-zero,
  autoscaling 0.25–4 CU
- Non-prod: 6-hour restore window, suspend after 5 minutes, autoscaling
  0.25–2 CU

Set `NEON_API_KEY` and `NEON_PROJECT_ID` in `apps/atta/.env`. Pulumi
looks up that project and copies the default-branch **pooled** URL into
`database_url` and the **direct** URL into `database_direct_url`. If the
lookup fails, the apply fails.

Tune compute, PITR, snapshots, and branch protection in the Neon Console.
Those settings are not in this stack.

After the first `pulumi up`, control-plane migrations already ran as
part of that apply (see Deploy). Re-run them out of band with:

```bash
pnpm --filter @atta/infra migrate
```

That invokes the migrate Lambda, which uses the **direct** Neon URL.

## Deploy

Use **`mise //apps/atta:deploy:aws`**. `mise //apps/atta:deploy` runs AWS
**and** the on-prem fleet in parallel.

1. Install the Pulumi CLI (`mise install` includes it) and log in
   (`pulumi login`).
2. Copy `apps/atta/.env.example` → `apps/atta/.env` and fill AWS,
   Cloudflare, Neon (`NEON_API_KEY`, `NEON_PROJECT_ID`), and Gemini
   values. Create the Neon project first (see [Neon](#neon)). Do **not**
   deploy with the local MinIO dummy keys
   (`AWS_ACCESS_KEY_ID=atta`). Pulumi and the AWS SDK read those
   names. Use an IAM role/profile, or a dedicated file:

   ```bash
   ENV_FILE=apps/atta/.env.aws mise //apps/atta:deploy:aws
   ```

   Omit `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in that file so the
   SDK uses the shared credentials file or SSO.

3. Select the stack named after `ENV` (`pulumi stack select --create`
   on `mise //apps/atta:deploy:aws` creates it if missing):

   ```bash
   cd apps/atta/deploy/aws
   pulumi stack select --create "$ENV"
   ```

4. Build and deploy from the repo root:

   ```bash
   mise //apps/atta:deploy:aws
   ```

   That runs `pnpm run build` (PWA assets + Go Lambda zips) then
   `pulumi up --yes` for `@atta/infra`. Preview without applying:

   ```bash
   pnpm --filter @atta/infra synth
   ```

   When the migrate Lambda package changes (control-plane or tenant SQL
   lives in that zip), Pulumi updates it, invokes it, and only then
   publishes the other Lambdas and web objects. If the invoke fails, the
   apply stops and application artifacts stay on the previous version.

5. Confirm ACM DNS records in Cloudflare and `pulumi stack output`
   (`webUrl`, `apiUrl`, `ssmParameterName`, `neonProjectId`,
   `jobsQueueUrl`, `migrateFunctionName`).

CI and staging apply from GitHub:
[GitHub setup (CI and staging deploy)](./github-actions.md).
Pushes to `develop` run `pnpm run build && turbo run deploy --filter=@atta/infra`
with `ENV=staging`. The
workflow assumes an IAM role via OIDC; configure the GitHub **staging**
environment secrets and variables before the first run. `master` / `prod`
is not wired yet.

## Schedules

EventBridge Scheduler (not EventBridge rules). Unix crontab on-prem is
5-field; AWS cron is 6-field with `?`.

| Name                   | Expression          | Target           | When                                       |
| ---------------------- | ------------------- | ---------------- | ------------------------------------------ |
| `outbox-relay`         | `rate(1 minute)`    | relay Lambda     | Always                                     |
| `outbox-sweeper`       | `rate(1 hour)`      | scheduler Lambda | Always                                     |
| `catalog-import-purge` | `cron(0 5 * * ? *)` | scheduler Lambda | Always (05:00 UTC)                         |
| `inbox-sync-all`       | `rate(5 minutes)`   | scheduler Lambda | Google or Microsoft OAuth client id+secret |

## Constraints

- `AWS_REGION` must be `us-east-1` (CloudFront ACM + CloudFront WAF).
- `ENV`, `AWS_ACCOUNT_ID`, `ROOT_DOMAIN`, `CLOUDFLARE_API_TOKEN`,
  `NEON_API_KEY`, `NEON_PROJECT_ID`, and `GEMINI_API_KEY` are required.
- Optional: `APP_SUBDOMAIN` (default `app`), `MEDIA_SUBDOMAIN` (default
  `media`), `API_ORIGIN_SUBDOMAIN` (default `api`), `ALARM_EMAIL`,
  `GEMINI_MODEL`, `GEMINI_ENDPOINT`, Google/Microsoft OAuth client ids
  and secrets.
- Web assets come from `apps/atta/pwa/dist/pwa/browser` (the root build
  produces this before Pulumi runs).
- S3 web deploy does not prune hashed bundles, so old clients can still load
  previous chunks.
- Cloudflare API token needs Zone Read + DNS Edit on `ROOT_DOMAIN`.
- OAuth redirect URIs at the identity provider must use the app host
  (`https://app.<ROOT_DOMAIN>/api/v1/auth/.../callback`), not a
  separate `api.` hostname.

## CloudFront / cache

- `/api*` → API Gateway custom domain (`api.<ROOT_DOMAIN>`), cache disabled.
  `execute-api` endpoint is disabled. CloudFront sends `X-Origin-Verify`;
  the regional WAF blocks requests without it. Origin request policy
  `AllViewerExceptHostHeader` so API Gateway sees the origin `Host`.
- Other paths → S3 (PWA). A CloudFront Function rewrites extensionless
  SPA routes to `/index.html`. Do not use distribution-wide 403/404
  custom error pages: they would rewrite API 404s into the SPA shell.
- Hashed assets: `Cache-Control: public, max-age=31536000, immutable`
- Entry points (`index.html`, `ngsw*`, manifest):
  `max-age=0, must-revalidate, s-maxage=300`. There is no CloudFront
  invalidation; a new `index.html` can take up to five minutes to appear
  at the edge.
- WAF: CloudFront (scope `CLOUDFRONT`) and API Gateway stage (scope
  `REGIONAL`). Managed rule groups: Amazon IP Reputation, Common,
  Known Bad Inputs, SQLi.
