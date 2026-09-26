# Frontend architecture

## Stack

- Angular 21, zoneless (`provideZonelessChangeDetection`)
- Signals + NgRx SignalStore (`@ngrx/signals`) — not classic NgRx/Redux
- Tailwind 4 + Spartan UI
- Angular service worker (PWA)
- Vitest via `@angular/build:unit-test`

## State

1. Local: `signal()` / `computed()` in the component.
2. Shared simple: injectable service exposing signals.
3. Global / multi-entity async: SignalStore + `rxMethod` for HTTP.

Keep feature orchestration in `*/application/*store.ts`; keep presentation thin.

## Shared UI

- Components: `apps/atta/pwa/src/app/core/presentation/components/`
- Layouts: `apps/atta/pwa/src/app/core/presentation/layouts/`
- Helm primitives: `apps/atta/pwa/src/app/shared/ui/` — see [Spartan UI](../frontend/spartan-ui.md)
- Tokens: semantic classes from `styles.css` (`bg-background`, `text-muted-foreground`), not hardcoded palettes

### Feedback

| Kind                            | When                             |
| ------------------------------- | -------------------------------- |
| Toast (`ToastService` / Sonner) | Global 5xx, network, success     |
| `<hlm-alert>`                   | Contextual 4xx / form validation |

`error.interceptor.ts` handles JSON:API errors and auto-toasts 5xx/network.

### Tenant shell

`TenantLayoutComponent` wraps `/:tenantId/*` with a collapsible sidebar.
The brand block shows the app name. Clicking `Versión {PRODUCT_VERSION}`
at the bottom of the navigation column opens an about dialog (version,
build, revision, release date). `tenant.interceptor.ts` sets
`X-Tenant-ID` from the path. See [Product versioning](./product-versioning.md).

### Patterns

- **Master-detail:** full-height split pane (unified inbox).
- **Dialogs:** Spartan `<hlm-dialog>` / `<hlm-alert-dialog>` (prefer these over bespoke modals).

## Key paths

- Config: `app.config.ts`, `angular.json`, `ngsw-config.json`,
  `public/manifest.webmanifest`
- API origin: `src/environments/environment.ts` (`apiUrl`). Local
  points at `https://app.atta.dev`. The production build uses an
  empty `apiUrl` so `/api/v1/...` stays same-origin on CloudFront and
  on-prem.

## Verify PWA build

```bash
pnpm --filter @atta/pwa build
pnpm --filter @atta/pwa preview:web
```

Open `http://localhost:4300` → DevTools → Application.
