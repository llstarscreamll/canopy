# GitHub setup (CI and staging deploy)

This page is the GitHub-side checklist for the current release model:
**`develop` deploys AWS `staging`**. Production (`master` → `prod`) is not
wired yet. Stack behavior lives in [AWS deploy](./aws.md). Application
secrets at runtime live in [AWS secrets](./ssm-secrets.md), not in GitHub.

## Deployment model

| Name      | Git branch | GitHub Environment | Pulumi `ENV` | Status           |
| --------- | ---------- | ------------------ | ------------ | ---------------- |
| `staging` | `develop`  | `staging`          | `staging`    | Wired in Actions |
| `prod`    | `master`   | —                  | `prod`       | Not wired        |

Use that same string for the AWS `Environment` tag, resource prefix
(`staging-atta-*`), SSM path (`/atta/staging/secrets`), and
the Neon default branch. Do not name the stack `develop` or `test`.

| Workflow                           | When it runs                                                  | What it does                                                     |
| ---------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `.github/workflows/ci.yml`         | Every pull request; every push to `develop` and `master`      | `pnpm run lint`, `test`, and `build` using `apps/atta/.env.test` |
| `.github/workflows/deploy-aws.yml` | Push to `develop` (docs-only paths skipped); **Run workflow** | `pnpm run build` then `@atta/infra` deploy with `ENV=staging`    |

Before packaging, set `ATTA_BUILD` (monotonic int) and optionally
`ATTA_REVISION` so store-safe build identity is embedded. See
[Product versioning](../architecture/product-versioning.md). Default
fallback is `git rev-list --count HEAD` (needs a full clone).

The deploy job authenticates to AWS with GitHub OIDC (`id-token: write`).
Do not store `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` in GitHub.

CI does not read deploy secrets. Put every deploy value on the **staging**
environment, not at repository level, so only jobs with
`environment: staging` can see them.

## Prerequisites (outside GitHub)

Complete these before the first Actions deploy. The workflow fails closed
if any required value is missing.

1. **Cloudflare.** Create a DNS zone whose name equals staging
   `ROOT_DOMAIN` (Pulumi looks up the zone by exact name). Typical value:
   `staging.money-path.co` → app host `https://app.staging.money-path.co`.
   Issue an API token with Zone Read and DNS Edit on that zone.
2. **Neon.** Create one project for staging in the
   [Neon Console](https://console.neon.tech) (region `aws-us-east-1`,
   default branch `staging`). Copy the project id. Create an API key that
   can read that project. See [AWS deploy — Neon](./aws.md#neon).
3. **Pulumi Cloud.** Confirm the `atta` project exists in your org.
   Create an access token at
   [Pulumi access tokens](https://app.pulumi.com/account/tokens).
4. **AWS IAM (OIDC).** Create the GitHub OIDC provider and a deploy role
   whose trust policy allows this repository and the `staging` environment.
   Follow [AWS OIDC bootstrap](#aws-oidc-bootstrap). Copy the role ARN.

## GitHub setup

Do this in the GitHub UI for `llstarscreamll/canopy` (or your fork).
You need permission to manage Environments, Actions secrets, and branch
protection.

### 1. Create the `staging` environment

1. Open **Settings → Environments**.
2. Select **New environment**.
3. Name it exactly `staging` (the workflow sets `environment: staging`).
4. Select **Configure environment**.

Leave **Required reviewers** unset so every push to `develop` applies.
Add reviewers later if you want a human gate.

### 2. Limit the environment to `develop`

1. On the **staging** environment page, under **Deployment branches and
   tags**, select **Selected branches and tags**.
2. Add a branch rule for `develop`.

That blocks **Run workflow** from another branch from using these
secrets.

### 3. Add environment variables

On the **staging** environment page, under **Environment variables**,
add:

| Name                   | Required | Example                                     |
| ---------------------- | -------- | ------------------------------------------- |
| `AWS_ROLE_ARN`         | yes      | `arn:aws:iam::123456789012:role/atta-gha`   |
| `AWS_ACCOUNT_ID`       | yes      | `123456789012`                              |
| `ROOT_DOMAIN`          | yes      | `staging.money-path.co`                     |
| `NEON_PROJECT_ID`      | yes      | Neon project id for staging                 |
| `APP_SUBDOMAIN`        | no       | `app`                                       |
| `MEDIA_SUBDOMAIN`      | no       | `media`                                     |
| `API_ORIGIN_SUBDOMAIN` | no       | `api`                                       |
| `GEMINI_MODEL`         | no       | `gemini-2.0-flash`                          |
| `GEMINI_ENDPOINT`      | no       | `https://generativelanguage.googleapis.com` |
| `ALARM_EMAIL`          | no       | `ops@example.com`                           |
| `SUPPORT_EMAIL`        | yes      | `soporte@example.com` (about / health)      |
| `TERMS_URL`            | no       | Terms URL for about / health                |
| `PRIVACY_URL`          | no       | Privacy URL for about / health              |

The workflow hardcodes `ENV=staging` and `AWS_REGION=us-east-1`. Do not
add those as variables.

Omit an optional variable to use the Pulumi default. An empty GitHub
variable is the same as unset for this stack.

### 4. Add environment secrets

On the same **staging** environment page, under **Environment secrets**,
add:

| Name                      | Required | Used for                                       |
| ------------------------- | -------- | ---------------------------------------------- |
| `PULUMI_ACCESS_TOKEN`     | yes      | Pulumi Cloud login                             |
| `CLOUDFLARE_API_TOKEN`    | yes      | Zone Read + DNS Edit on `ROOT_DOMAIN`          |
| `NEON_API_KEY`            | yes      | Read the existing Neon project                 |
| `GEMINI_API_KEY`          | yes      | Invoice extraction (copied into SSM)           |
| `GOOGLE_CLIENT_ID`        | no       | Gmail OAuth; enables `inbox-sync-all`          |
| `GOOGLE_CLIENT_SECRET`    | no       | Gmail OAuth                                    |
| `MICROSOFT_CLIENT_ID`     | no       | Microsoft mail OAuth; enables `inbox-sync-all` |
| `MICROSOFT_CLIENT_SECRET` | no       | Microsoft mail OAuth                           |

Do **not** add:

- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (OIDC assumes the role)
- JWT secrets, inbox encryption keys, or tenant encryption keys (Pulumi
  generates them into state and SSM)

If you set Google or Microsoft, set **both** the client id and the
secret. A lone id does not enable mail sync.

### 5. Protect `develop`

1. Open **Settings → Branches → Add branch ruleset** (or the classic
   **Add branch protection rule**).
2. Target `develop`.
3. Require the status check **CI / Lint, test, build** before merge.
4. Do not require **Deploy AWS** on pull requests. That workflow does
   not run on PRs.

Optional: require a pull request so `develop` is not pushed directly.
Direct pushes still deploy if the branch rule allows them.

### 6. Confirm Actions can use OIDC

1. Open **Settings → Actions → General**.
2. Allow GitHub Actions to run (default for a private repo).
3. Under **Workflow permissions**, **Read repository contents** is
   enough. The deploy workflow requests `id-token: write` itself.

No extra OIDC toggle is required in GitHub.

## First deploy

1. Merge (or push) the workflow files onto `develop`, or open **Actions
   → Deploy AWS → Run workflow** and select `develop`.
2. A push that only changes `*.md`, `docs/**`, or `.specs/**` skips
   deploy. Change application or infra files, or use **Run workflow**.
3. Open the **Pulumi up (staging)** job. The first step fails with a
   named `::error::` if a required variable or secret is missing.
4. If AWS assume-role fails, copy the token `sub` from the log and match
   the IAM trust policy exactly (see [AWS OIDC bootstrap](#aws-oidc-bootstrap)).
5. After a green apply, confirm Pulumi stack outputs: `webUrl`, `apiUrl`,
   `ssmParameterName`, `neonProjectId`.

The job installs Node 24, pnpm 11.5.1, Go 1.25, and Pulumi 3.x, assumes
`AWS_ROLE_ARN`, then runs `pnpm run build && turbo run deploy --filter=@atta/infra`
(`pulumi stack select --create staging` and `pulumi up --yes`). First
CloudFront / ACM apply can take most of the 60-minute job timeout.

## AWS OIDC bootstrap

Do this once in the AWS account. IAM is global; the app stack still
deploys to `us-east-1`.

1. Create the GitHub OIDC provider if it does not exist:

   ```bash
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com \
     --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
   ```

2. Create an IAM role (for example `atta-gha`). Restrict `sub` to
   this repository and the **staging** environment.

   Jobs with `environment: staging` present a subject like:

   ```text
   repo:OWNER/REPO:environment:staging
   ```

   Repositories created after 15 July 2026 (or opted into immutable
   claims) include owner and repository ids:

   ```text
   repo:OWNER@ORG_ID/REPO@REPO_ID:environment:staging
   ```

   Example trust policy (replace account, owner, and repo). If
   assume-role fails, copy `sub` from the job log and match it exactly:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
           },
           "StringLike": {
             "token.actions.githubusercontent.com:sub": "repo:OWNER/REPO:environment:staging"
           }
         }
       }
     ]
   }
   ```

3. Attach permissions the Pulumi program needs (Lambda, API Gateway,
   CloudFront, WAF, S3, IAM, SSM, KMS, SQS, EventBridge, EventBridge
   Scheduler, ACM, CloudWatch, SNS). For the first apply, attaching
   `AdministratorAccess` is the practical option; tighten later.

4. Set the role **Maximum session duration** to at least 1 hour
   (default). First CloudFront / ACM applies can run close to that limit.

5. Put the role ARN in the **staging** environment variable
   `AWS_ROLE_ARN`.

## What GitHub does not own

| Concern                 | Where it lives                                                |
| ----------------------- | ------------------------------------------------------------- |
| Pulumi stack state      | Pulumi Cloud (`atta` / `staging`)                             |
| JWT and encryption keys | Pulumi state + SSM `/atta/staging/secrets`                    |
| Neon project lifecycle  | Neon Console (`NEON_PROJECT_ID` is lookup-only)               |
| On-prem fleet           | Not in these workflows                                        |
| Local deploy            | `mise //apps/atta:deploy:aws` (loads `apps/atta/.env.deploy`) |
