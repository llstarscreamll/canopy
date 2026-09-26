# AWS secrets (Parameter Store)

Applies when `DEPLOYMENT_TARGET=aws`. Local and on-prem use plain `.env`
([backend-api](../architecture/backend-api.md#config-and-secrets)).

AWS Lambdas load one JSON blob at cold start (`config.Load()`), then
`platform.NewModule()` uses that `Config` to open Postgres, S3, and the
outbox adapters. The store is **SSM Parameter Store** (`SecureString`),
encrypted with the stack customer-managed KMS key.

Do not put this JSON in Lambda environment variables. Env holds
non-secret routing only.

## Parameter

| Setting              | Default | Description                         |
| -------------------- | ------- | ----------------------------------- |
| `SSM_PARAMETER_NAME` | (none)  | Required on `DEPLOYMENT_TARGET=aws` |

Pulumi writes `/atta/${ENV}/secrets` as a Standard-tier
`SecureString` (`keyId` = stack CMK) and sets `SSM_PARAMETER_NAME` on
every Lambda.

`config.Load()` calls `GetParameter` with `WithDecryption: true` and
unmarshals snake_case JSON into
`apps/atta/backend/internal/platform/config/config.go`. Empty
`SSM_PARAMETER_NAME` on AWS is a boot error; there is no Secrets
Manager path.

Standard Parameter Store is 4 KB. Keep this payload under that limit.

## Runtime path

1. Lambda env: `DEPLOYMENT_TARGET=aws`, `SSM_PARAMETER_NAME`, public URLs.
2. `config.Load()` decrypts the parameter and fills `Config` (Neon URLs,
   queue URL, event bus, S3 bucket, JWT, encryption keys, Gemini, OAuth).
3. `platform.NewModule()` instantiates the infrastructure layer from
   that `Config` (control-plane pool, tenant registry, S3, outbox).
4. Entrypoints (`cmd/aws/lambda/*`) consume the module. The migrate
   Lambda calls `config.Load()` directly and uses
   `DirectDatabaseURL()`.

IAM on each function: `ssm:GetParameter` / `ssm:GetParameters` on the
parameter ARN, plus `kms:Decrypt` on the CMK.

## Required fields (AWS)

| Key                                | Type   | Description                                            |
| ---------------------------------- | ------ | ------------------------------------------------------ |
| `database_url`                     | string | Neon **pooled** Postgres URL (Lambda request path)     |
| `database_direct_url`              | string | Neon **direct** URL (migrations and `CREATE DATABASE`) |
| `sqs_queue_url`                    | string | SQS queue URL for background jobs                      |
| `event_bus_name`                   | string | EventBridge custom event bus name                      |
| `s3_bucket_name`                   | string | S3 bucket for object storage                           |
| `inbox_credentials_encryption_key` | string | Base64-encoded 32-byte AES key for inbox OAuth tokens  |
| `tenant_secrets_encryption_key`    | string | Base64-encoded key for tenant document passwords       |
| `gemini_api_key`                   | string | Google Gemini API key (invoice extraction)             |
| `jwt_access_secret`                | string | JWT access-token signing secret                        |
| `jwt_refresh_secret`               | string | JWT refresh-token signing secret                       |
| `messaging_attestation_secret`     | string | HMAC secret for job/event tenant attestation           |

`eventbridge_queue_url` is optional. The AWS events Lambda is invoked by
EventBridge directly.

## Optional fields (merged when present)

| Key                       | Type    | Description                                    |
| ------------------------- | ------- | ---------------------------------------------- |
| `google_client_id`        | string  | Gmail OAuth client ID                          |
| `google_client_secret`    | string  | Gmail OAuth client secret                      |
| `microsoft_client_id`     | string  | Microsoft mail OAuth client ID                 |
| `microsoft_client_secret` | string  | Microsoft mail OAuth client secret             |
| `gemini_model`            | string  | Gemini model id (default `gemini-2.0-flash`)   |
| `gemini_endpoint`         | string  | Gemini API base URL                            |
| `app_env`                 | string  | Channel: `local` \| `staging` \| `production`  |
| `allowed_origins`         | string  | Comma-separated CORS origins                   |
| `frontend_url`            | string  | PWA base URL                                   |
| `backend_url`             | string  | Public API origin (same host as the PWA)       |
| `support_email`           | string  | Support contact for about / `GET /api/health`  |
| `terms_url`               | string  | Optional terms-of-service URL                  |
| `privacy_url`             | string  | Optional privacy-policy URL                    |
| `license_label`           | string  | License label (default `Software propietario`) |
| `debug`                   | boolean | Enable debug mode (not written by Pulumi)      |

## Not in the parameter (Lambda env only)

- `DEPLOYMENT_TARGET=aws`
- `AWS_REGION`
- `SSM_PARAMETER_NAME`
- `TENANT_MIGRATIONS_DIR` (HTTP and migrate Lambdas)
- `ALLOWED_ORIGINS`, `FRONTEND_URL`, `BACKEND_URL` (also copied into JSON)

On-prem-only keys (`rabbitmq_url`, `minio_endpoint_url`, and similar)
belong in `.env`, not this parameter.

## Neon URLs

Use the pooler hostname (`-pooler`) for `database_url`. PgBouncer
transaction mode cannot run `CREATE DATABASE` or some migration session
features, so `database_direct_url` must omit `-pooler`.

Pulumi fills both from a lookup of `NEON_PROJECT_ID` (the stack does not
create or delete the Neon project).

## Example payload

Pulumi always writes `app_env`, `allowed_origins`, `frontend_url`, and
`backend_url` alongside the required keys.

```json
{
  "app_env": "production",
  "database_url": "postgres://atta:secret@ep-xxx-pooler.us-east-1.aws.neon.tech/atta?sslmode=require",
  "database_direct_url": "postgres://atta:secret@ep-xxx.us-east-1.aws.neon.tech/atta?sslmode=require",
  "sqs_queue_url": "https://sqs.us-east-1.amazonaws.com/ACCOUNT_ID/prod-atta-jobs",
  "event_bus_name": "prod-atta-bus",
  "s3_bucket_name": "prod-atta-ACCOUNT-objects",
  "google_client_id": "your-google-client-id.apps.googleusercontent.com",
  "google_client_secret": "your-google-client-secret",
  "microsoft_client_id": "your-microsoft-client-id",
  "microsoft_client_secret": "your-microsoft-client-secret",
  "gemini_api_key": "your-gemini-api-key",
  "gemini_model": "gemini-2.0-flash",
  "gemini_endpoint": "https://generativelanguage.googleapis.com",
  "inbox_credentials_encryption_key": "base64-encoded-32-byte-key",
  "tenant_secrets_encryption_key": "base64-encoded-32-byte-key",
  "jwt_access_secret": "generated-access-secret",
  "jwt_refresh_secret": "generated-refresh-secret",
  "messaging_attestation_secret": "generated-attestation-secret",
  "allowed_origins": "https://app.example.com,https://example.com",
  "frontend_url": "https://app.example.com",
  "backend_url": "https://app.example.com"
}
```

After you update the parameter, wait for a Lambda cold start so the
process reloads config. You can also publish a new function version.
