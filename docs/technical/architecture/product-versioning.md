# Product versioning

Canopy is the habitat monorepo and does not ship a commercial SemVer.
Each commercial system under `apps/<product>/` owns its own product
version.

The habitat codename (for example Atta) is **internal only**. Do not show
it in user-facing UI. Show SemVer (and optionally build) instead.

## Identity fields

| Field       | Format                               | Example                     | Purpose                                                                                          |
| ----------- | ------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------ |
| Version     | SemVer                               | `0.1.0`                     | User-facing version, changelog, store `versionName` / `CFBundleShortVersionString`               |
| Build       | Monotonic `uint`                     | `1847`                      | Store ordering: Android `versionCode`, Apple `CFBundleVersion`, deb/rpm revision, Electron build |
| Revision    | Short git SHA (7)                    | `a3f2c1b`                   | Support / exact VCS identity; **not** for store ordering                                         |
| Released at | ISO 8601 datetime                    | `2026-09-18T12:34:56-05:00` | Commit/build datetime for this identity                                                          |
| Entorno     | `local` \| `staging` \| `production` | —                           | Deployment channel (`APP_ENV`, required)                                                         |

### Why this shape

| Candidate as build                 | Verdict                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Short git SHA                      | Not monotonic; not an int; rejected by Android `versionCode` and awkward for Apple / apt |
| Full datetime int (`YYYYMMDDHHMM`) | Exceeds Android `versionCode` max (`2100000000`)                                         |
| SemVer alone                       | Stores still need a separate increasing build when you resubmit the same SemVer          |
| Monotonic int                      | Works on web, iOS, Android, Linux packages, and macOS                                    |

### How build is resolved

1. `ATTA_BUILD` if set (CI should set this, typically `GITHUB_RUN_NUMBER`).
2. Else `git rev-list --count HEAD` (full clone required; avoid shallow
   clones in release jobs, or always set `ATTA_BUILD`).

Revision:

1. `ATTA_REVISION` or `GITHUB_SHA` (shortened to 7 chars).
2. Else `git rev-parse --short=7 HEAD`.

Release datetime (`released_at` / `PRODUCT_RELEASED_AT`):

1. `ATTA_RELEASED_AT` (ISO 8601 datetime) if set.
2. Else `git log -1 --format=%cI`.

Deployment channel (`APP_ENV` / `environment` in health / Entorno in UI):

| Value        | Typical use              |
| ------------ | ------------------------ |
| `local`      | Local development        |
| `staging`    | Staging / pre-production |
| `production` | Production               |

`APP_ENV` is **required** at API boot (exact values only; no aliases).
AWS Pulumi stack slug `ENV=staging|prod` is separate from the product
channel: Lambda/`SSM` `app_env` is set to `staging` \| `production`.

Range: build must stay in `1..2100000000` (Android limit).

Deploy image tags (`ONPREM_RELEASE`) can keep using sha or
`{version}+{build}.{revision}` for rollback; that is separate from the
store build number.

## Atta source of truth

| Item                           | Location                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Product SemVer                 | `apps/atta/package.json` (`@atta/product`.version)                                                         |
| TypeScript exports             | `@atta/product` → `PRODUCT_VERSION`, `PRODUCT_BUILD`, `PRODUCT_REVISION`, `PRODUCT_RELEASED_AT`, `APP_ENV` |
| Generated build info           | `apps/atta/src/build-info.ts`                                                                              |
| Go constants (generated)       | `apps/atta/backend/internal/platform/product/version.go`                                                   |
| Child package `version` fields | `@atta/backend`, `@atta/pwa`, `@atta/e2e`, `@atta/infra`, `@atta/onprem`                                   |

Bump only `@atta/product` SemVer. Then sync (also refreshes build +
revision):

```bash
mise //apps/atta:version:sync
# CI example:
# ATTA_BUILD="$GITHUB_RUN_NUMBER" ATTA_REVISION="$GITHUB_SHA" mise //apps/atta:version:sync
```

Drift check (SemVer mirrors only; build/revision refresh on every sync):

```bash
mise //apps/atta:version:check
```

### What belongs in `@atta/product`

Keep this package metadata-only:

- `name`, `version`, `private`, `description`
- `exports` for the TypeScript entry
- `scripts.sync-version` / `scripts.lint` (`--check`)

Do **not** put app dependencies, Angular/Go build config, or deploy
tooling here. npm/pnpm cannot extend `package.json`; child packages do
not inherit from `@atta/product`. They either:

1. Depend on `@atta/product` and import the exports (PWA), or
2. Carry a mirrored `version` field kept in sync (all `@atta/*`
   packages), or
3. Use the generated Go constants (backend).

### Git tags

Tag releases per product, not for Canopy:

```text
atta/v0.1.0
threehopper/v2.0.0
```

### Surfaces

All product clients (backend, PWA, future desktop/mobile) share the same
SemVer and the same build number for a given release train. Mobile /
desktop map:

| Platform    | SemVer field                 | Build field       |
| ----------- | ---------------------------- | ----------------- |
| Android     | `versionName`                | `versionCode`     |
| iOS / macOS | `CFBundleShortVersionString` | `CFBundleVersion` |
| Linux (deb) | upstream version             | debian revision   |
| Web / PWA   | `PRODUCT_VERSION` (UI)       | health / support  |

### Runtime exposure

- PWA sidebar shows `Versión {PRODUCT_VERSION}`; click opens an about
  dialog with client identity, API/install identity (from
  `GET /api/health`), support email, and license/terms links.
- `GET /api/health` includes `version`, `build`, `revision`,
  `released_at` (ISO datetime), `environment` (`local` \| `staging` \|
  `production` from `APP_ENV`), `support_email`, optional `terms_url` /
  `privacy_url`, and `license_label`.
- `SUPPORT_EMAIL` falls back to `soporte@atta.com` when `APP_ENV` is
  `local` and the env var is unset.
- Outside `local`, `SUPPORT_EMAIL` is required at API boot
  (`validateSecurityConfig`) and at AWS Pulumi config load
  (`required('SUPPORT_EMAIL')`). On-prem VMs must set it in
  `apps/atta/deploy/onprem/.env`.

## Future products

Add `apps/<name>/package.json` as `@<name>/product` with the same sync
script pattern. Start SemVer wherever that product's lifecycle requires
(`0.0.1`, `0.1.0`, or `2.0.0`). Versions never need to match Atta.
