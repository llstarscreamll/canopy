# AWS Organizations landing zone

Automates the multi-account layout for **one** management root at a time:
organizational units (OUs), foundation accounts, product×environment workload
accounts, Service Control Policies (SCPs), IAM Identity Center permission sets,
organization CloudTrail + GuardDuty baseline, and an optional monthly budget.

This is an **occasional operator command**, not a CI/CD pipeline. Product
workloads (for example Atta Pulumi) stay in `apps/<product>/deploy/aws` and are
unchanged by this program.

Package: `infra/landing-zone` (`@canopy/landing-zone`).

## What it creates

```text
Root (management account — already yours)
├── Security OU
│   ├── log-archive          # org CloudTrail bucket (when SECURITY_BASELINE)
│   └── security-tooling     # GuardDuty org admin (when SECURITY_BASELINE)
├── Infrastructure OU
│   ├── shared-services
│   └── network              # only if NETWORK_HUB=true (account stub; no TGW)
├── Transition OU            # break-glass: no DenyLeave SCP
└── Workloads OU
    ├── NonProd — {product}-{env} (+ cost SCP)
    └── Prod    — {product}-{env} (+ destructive-delete SCP)
```

### SCPs

| Policy                          | Target                              | Purpose                                                  |
| ------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| Deny leave organization         | Security, Infrastructure, Workloads | Keep accounts under governance                           |
| Deny security/audit destruction | Security OU                         | Protect CloudTrail/GuardDuty/S3 audit assets             |
| Deny high-impact deletes        | Prod OU                             | Reduce accidental teardown (not a full lock)             |
| Deny expensive creates          | NonProd OU                          | Block NAT/TGW/EKS/Redshift/SageMaker/… spend             |
| Deny non-home regions           | Workloads OU                        | Limit regional blast radius (`AWS_REGION` + `us-east-1`) |

**Transition OU** has no DenyLeave attachment. To allow an approved exit: move
the account into Transition, complete the leave/migration, then remove it.

SCPs never apply to the **management** account. Do not run product workloads
there.

### Security baseline (`SECURITY_BASELINE=true`, default)

| Control                                               | Where                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| Multi-region organization CloudTrail + log validation | Management trail → versioned SSE-S3 bucket in `log-archive` |
| GuardDuty organization admin + auto-enable members    | `security-tooling`                                          |
| Optional `MONTHLY_BUDGET_USD` + `BUDGET_ALERT_EMAIL`  | Management account AWS Budgets                              |

### SSO permission sets (`SSO_PERMISSION_SETS=true`)

| Permission set     | Access                       | Typical use                                                                                       |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `PlatformAdmin`    | AdministratorAccess          | Break-glass humans only                                                                           |
| `ProductDeveloper` | PowerUserAccess              | Human day-to-day on NonProd                                                                       |
| `ProductReadonly`  | ReadOnlyAccess               | Human read-only (can still read some secrets via managed policy)                                  |
| `ProductMCP`       | ReadOnlyAccess + inline Deny | AI MCP / agentic debug: blocks SSM/Secrets reads, Lambda config, destructive APIs; session **4h** |

Optional **AccountAssignments** from dotenv (Identity Center user/group UUIDs):

| Variable                                  | Permission set     | Target accounts                     |
| ----------------------------------------- | ------------------ | ----------------------------------- |
| `SSO_PLATFORM_ADMIN_USERS` / `_GROUPS`    | `PlatformAdmin`    | Management                          |
| `SSO_STAGING_DEVELOPER_USERS` / `_GROUPS` | `ProductDeveloper` | Non-prod workloads (`*-staging`, …) |
| `SSO_STAGING_MCP_USERS` / `_GROUPS`       | `ProductMCP`       | Non-prod workloads                  |
| `SSO_PROD_READONLY_USERS` / `_GROUPS`     | `ProductReadonly`  | Prod workloads                      |

Empty lists skip that assignment. Users/groups are still created in the Identity
Center console (or SCIM); the stack only links them to accounts. Prefer
**ProductMCP** on staging first; reserve **PlatformAdmin** for break-glass.

## First-time setup (each new management root)

Repeat this for every partner company that has its own AWS management account
(for example Alar, Goshen). Do **not** share one Organization across companies.

Control Tower is optional. This program uses Organizations APIs directly.

### Pre-flight checklist (AWS Console)

Complete these steps in the **management** account before the first
`mise //infra/landing-zone:up`.

#### 1. Secure the root user

1. Sign in as the account **root** user (foundational signup email).
2. Enable **MFA** on the root user.
3. Prefer daily work via Identity Center after step 4; keep root for rare
   account-recovery and billing tasks only.

#### 2. AWS Organizations

1. Open **AWS Organizations**. Create the organization if it does not exist.
2. Confirm **Feature set** is **All features** (Settings). If the org is still
   consolidated-billing-only, enable all features (irreversible) and finalize.
3. Under **Policies**, enable **Service control policies (SCPs)**.
4. Ignore optional banners about **Resource control policies (RCPs)** for the
   first landing-zone apply unless you plan to use RCPs immediately.

#### 3. IAM Identity Center

1. Open **IAM Identity Center** → **Enable**.
2. Confirm the Region is **US East (N. Virginia)** (`us-east-1`). The Identity
   Center primary Region is sticky; it must match `AWS_REGION` in `.env`.
3. Choose **Single-Region instance** (not Multi-Region) unless you already
   operate workloads outside `us-east-1`.
4. Confirm the summary shows:
   - **Permission set** (Manage AWS account access): **Enabled** (cannot enable
     later)
   - **Primary Region**: US East (N. Virginia) (cannot change later)
   - **Additional Region**: None
   - Encryption: AWS owned key is fine for V1
5. Choose **Enable**.

#### 4. First Identity Center admin user

Create a daily-ops admin that is **not** the AWS root user.

| Field        | Recommendation                                                  |
| ------------ | --------------------------------------------------------------- |
| Email        | Company Workspace admin (for example `admin@alarcomputing.com`) |
| Username     | Short login id (for example `admin`)                            |
| Display name | Distinct from root, for example `Identity Center Admin`         |

Use the **company domain** for Identity Center and for CreateAccount emails—not
a partner personal domain and not the Gmail used only as AWS root signup.
Forwarding from Workspace to another inbox (for example Goshen) is fine for
reading mail; the address on the identity should still be the company domain.

1. Accept the invitation and enable **MFA** on this user.
2. Bookmark the **AWS access portal** URL.
3. From then on, sign in with Identity Center; avoid root for routine work.

#### 5. Prove CreateAccount email delivery

Member accounts use plus-addressing:

`{ACCOUNT_EMAIL_LOCAL}+{ORGANIZATION_NAME}-{slug}@{ACCOUNT_EMAIL_DOMAIN}`

1. Send a test message to
   `{ACCOUNT_EMAIL_LOCAL}+{ORGANIZATION_NAME}-test@{ACCOUNT_EMAIL_DOMAIN}`.
2. Confirm it arrives (including any forward).
3. Do **not** run `up` until this works. Invalid CreateAccount emails can leave
   accounts hard to recover.

#### 6. Local credentials and tooling

1. Configure an AWS CLI SSO profile for this management account (Identity Center
   admin, not root access keys).
2. Run `aws sso login --profile <mgmt-profile>` and
   `aws sts get-caller-identity`. Confirm the Account ID is this company's
   management account.
3. Run `pulumi login` once for your state backend.
4. Copy and edit dotenv for **this** org only (see [Configure](#configure)).

#### 7. Preview before apply

```bash
export AWS_PROFILE=<mgmt-profile>
export ENV_FILE=infra/landing-zone/.env   # path for this company

mise //infra/landing-zone:preview
```

Confirm the plan creates the expected OUs, member accounts, SCPs, permission
sets (including `ProductMCP`), and—when enabled—CloudTrail, GuardDuty, and
budget. Confirm there is **no** `network` account unless `NETWORK_HUB=true`.

### After the first `up`

1. Do not cancel mid-apply; `CreateAccount` can take several minutes per
   account.
2. Save stack outputs (`accountIds`, `transitionOuId`, `orgTrailArn`,
   `orgTrailBucketName`).
3. Confirm Identity Center assignments (dotenv and/or console):
   - Management break-glass: `PlatformAdmin`
   - Workload NonProd humans: `ProductDeveloper` / `ProductReadonly`
   - AI MCP / agentic debug: `ProductMCP` on staging accounts first
4. Confirm Organization CloudTrail is logging and GuardDuty org admin is the
   `security-tooling` account.
5. Accept the AWS Budgets subscription email if you set
   `MONTHLY_BUDGET_USD`.
6. Confirm AWS “welcome” mail for new accounts reached the company inbox
   (via forward if configured).
7. Confirm Transition OU is **not** under a root-level DenyLeave SCP.
   `preview`/`up` run `scripts/detach-root-leave-scp.mjs` when
   `DETACH_ROOT_LEAVE_SCP=true` (default).

### Prerequisites (summary)

Before `up`, you must have:

1. Management credentials via Identity Center (`AWS_PROFILE`).
2. Organizations with **all features** and **SCPs** enabled.
3. Identity Center enabled (Single-Region `us-east-1`) when
   `SSO_PERMISSION_SETS=true`.
4. Deliverable company-domain plus-addressing for `ACCOUNT_EMAIL_*`.
5. `OrganizationAccountAccessRole` assumable in member accounts (default for
   accounts created by Organizations).

## Configure

```bash
cp infra/landing-zone/.env.example infra/landing-zone/.env
```

| Variable                                       | Purpose                                                |
| ---------------------------------------------- | ------------------------------------------------------ |
| `ORGANIZATION_NAME`                            | Label / Pulumi stack name / email slug                 |
| `AWS_REGION`                                   | Home region (default `us-east-1`)                      |
| `NETWORK_HUB`                                  | `true` creates empty `network` account (no TGW yet)    |
| `PRODUCTS` / `ENVIRONMENTS`                    | Workload account matrix                                |
| `ACCOUNT_EMAIL_LOCAL` / `ACCOUNT_EMAIL_DOMAIN` | CreateAccount emails                                   |
| `ALLOW_EXAMPLE_EMAIL`                          | Override placeholder-domain guard (default `false`)    |
| `SSO_PERMISSION_SETS`                          | Create Identity Center permission sets                 |
| `SSO_*_USERS` / `SSO_*_GROUPS`                 | Optional AccountAssignment UUIDs (see SSO table)       |
| `ACCOUNT_ALIASES`                              | IAM aliases `{org}-{slug}` on members (default `true`) |
| `DETACH_ROOT_LEAVE_SCP`                        | Detach legacy root DenyLeave\* SCPs (default `true`)   |
| `SECURITY_BASELINE`                            | Org CloudTrail + GuardDuty (default `true`)            |
| `MONTHLY_BUDGET_USD` / `BUDGET_ALERT_EMAIL`    | Optional cost alarm                                    |

Switch companies by switching AWS credentials and `ENV_FILE` (one dotenv per
management root). Do not put multiple management roots in one file. Keep each
company's `.env` gitignored; start from `.env.example`.

Example shape (Alar):

```bash
ORGANIZATION_NAME=alar
AWS_REGION=us-east-1
NETWORK_HUB=false
PRODUCTS=atta
ENVIRONMENTS=staging,prod
ACCOUNT_EMAIL_LOCAL=admin
ACCOUNT_EMAIL_DOMAIN=alarcomputing.com
SSO_PERMISSION_SETS=true
# SSO_PLATFORM_ADMIN_USERS=<identity-store-user-uuid>
ACCOUNT_ALIASES=true
DETACH_ROOT_LEAVE_SCP=true
SECURITY_BASELINE=true
MONTHLY_BUDGET_USD=100
BUDGET_ALERT_EMAIL=admin@alarcomputing.com
```

## Run

```bash
aws sso login --profile alar-mgmt
export AWS_PROFILE=alar-mgmt
export ENV_FILE=infra/landing-zone/.env

mise //infra/landing-zone:preview
mise //infra/landing-zone:up
```

`up` selects/creates a Pulumi stack named `$ORGANIZATION_NAME`.

Outputs include `accountIds`, `transitionOuId`, and (when baseline is on)
`orgTrailArn` / `orgTrailBucketName`.

## Tests

```bash
mise //infra/landing-zone:test
```

Unit tests cover SCP documents and a mocked Pulumi graph (including Transition
OU and security baseline resources). Live preview/apply stays manual.

## Adopting an existing organization

If OUs or accounts already exist with the same names, the first `up` fails.
Import into the Pulumi stack or rename/move the existing layout first. Prefer a
clean management account when possible.

If CloudTrail or GuardDuty org admin already exists, import those resources or
set `SECURITY_BASELINE=false` and wire them out-of-band.

## Cost notes

- Empty member accounts have negligible fixed cost.
- Organization CloudTrail (S3 storage + lifecycle) and GuardDuty findings are
  the main baseline spend.
- Keep `NETWORK_HUB=false` until you need VPC hub-and-spoke (Transit Gateway is
  not created in V1).
- NonProd SCP blocks common high-spend creates (NAT, EKS, Redshift, …).

## Related

- [AWS Lambda deployment](./aws.md) — product stack inside a workload account
- [GitHub Actions](./github-actions.md) — product CI/OIDC (not used here)
- [Monorepo layout](../architecture/monorepo.md)
