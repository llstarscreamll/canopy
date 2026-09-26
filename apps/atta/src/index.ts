import packageJson from '../package.json';

export { PRODUCT_BUILD, APP_ENV, PRODUCT_RELEASED_AT, PRODUCT_REVISION } from './build-info';

/**
 * Internal habitat codename. Do not show in user-facing UI.
 * Prefer PRODUCT_VERSION / PRODUCT_BUILD / PRODUCT_REVISION for display and support.
 */
export const PRODUCT_NAME = 'Atta' as const;

/**
 * Product SemVer. Source of truth: `apps/atta/package.json` (`@atta/product`).
 * Keep mirrors and generated build identity in sync via
 * `pnpm --filter @atta/product sync-version`.
 */
export const PRODUCT_VERSION: string = packageJson.version;
