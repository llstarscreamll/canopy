import * as fs from 'node:fs';
import * as path from 'node:path';
import dotenv from 'dotenv';

const repoRoot = path.resolve(__dirname, '../../..');
const defaultEnvFile = 'ops/aws-org/.env';
const envFileRaw = process.env.ENV_FILE?.trim();
const envPath = envFileRaw ? (path.isAbsolute(envFileRaw) ? envFileRaw : path.resolve(repoRoot, envFileRaw)) : path.join(repoRoot, defaultEnvFile);
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

/** Identity Center principals for optional AccountAssignment automation. */
export interface SsoAssignmentPrincipals {
  platformAdminUsers: string[];
  platformAdminGroups: string[];
  stagingDeveloperUsers: string[];
  stagingDeveloperGroups: string[];
  stagingMcpUsers: string[];
  stagingMcpGroups: string[];
  prodReadonlyUsers: string[];
  prodReadonlyGroups: string[];
}

export interface LandingZoneConfig {
  organizationName: string;
  awsRegion: string;
  networkHub: boolean;
  products: string[];
  environments: string[];
  accountEmailLocal: string;
  accountEmailDomain: string;
  ssoPermissionSets: boolean;
  /** Wire org CloudTrail → log-archive and GuardDuty admin → security-tooling. */
  securityBaseline: boolean;
  /** Create IAM account aliases `{org}-{slug}` on member accounts. */
  accountAliases: boolean;
  /**
   * Detach legacy root-attached DenyLeave* SCPs so Transition OU can allow
   * LeaveOrganization (our deny-leave SCP stays on Security/Infra/Workloads).
   */
  detachRootLeaveScp: boolean;
  ssoAssignments: SsoAssignmentPrincipals;
  /** Optional monthly Cost Explorer budget (USD). Undefined = skip. */
  monthlyBudgetUsd?: number;
  budgetAlertEmail?: string;
  repoRoot: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required in ${process.env.ENV_FILE?.trim() || defaultEnvFile}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function parseBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw === 'true' || raw === '1' || raw === 'yes') {
    return true;
  }
  if (raw === 'false' || raw === '0' || raw === 'no') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseList(name: string): string[] {
  return required(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseOptionalUuidList(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return [];
  }
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const id of ids) {
    if (!uuid.test(id)) {
      throw new Error(`${name} entry "${id}" must be an IAM Identity Center user/group UUID`);
    }
  }
  return ids;
}

/** Account email for Organizations CreateAccount (plus-addressing). */
export function accountEmail(cfg: LandingZoneConfig, accountSlug: string): string {
  return `${cfg.accountEmailLocal}+${cfg.organizationName}-${accountSlug}@${cfg.accountEmailDomain}`;
}

export function workloadAccountSlug(product: string, env: string): string {
  return `${product}-${env}`;
}

export function isProdEnvironment(env: string): boolean {
  return env === 'prod' || env === 'production';
}

/** Globally unique IAM account alias: `{organizationName}-{slug}` (max 63). */
export function memberAccountAlias(cfg: LandingZoneConfig, slug: string): string {
  const alias = `${cfg.organizationName}-${slug}`.toLowerCase();
  if (alias.length > 63) {
    throw new Error(`Account alias "${alias}" exceeds IAM 63-character limit`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) {
    throw new Error(`Account alias "${alias}" has invalid characters`);
  }
  return alias;
}

function assertDeliverableEmailDomain(domain: string, allowExample: boolean): void {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
    throw new Error(`ACCOUNT_EMAIL_DOMAIN "${domain}" is not a valid domain`);
  }
  const blocked = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'localhost']);
  if (!allowExample && blocked.has(domain.toLowerCase())) {
    throw new Error(`ACCOUNT_EMAIL_DOMAIN "${domain}" is not deliverable. Use a real mailbox domain, or set ALLOW_EXAMPLE_EMAIL=true only for dry runs that never call CreateAccount.`);
  }
}

export function loadConfig(): LandingZoneConfig {
  const products = parseList('PRODUCTS');
  const environments = parseList('ENVIRONMENTS');
  for (const p of products) {
    if (!/^[a-z][a-z0-9-]*$/.test(p)) {
      throw new Error(`PRODUCTS entry "${p}" must be lowercase alphanumeric/hyphen`);
    }
  }
  for (const e of environments) {
    if (!/^[a-z][a-z0-9-]*$/.test(e)) {
      throw new Error(`ENVIRONMENTS entry "${e}" must be lowercase alphanumeric/hyphen`);
    }
  }

  const accountEmailDomain = required('ACCOUNT_EMAIL_DOMAIN');
  assertDeliverableEmailDomain(accountEmailDomain, parseBool('ALLOW_EXAMPLE_EMAIL', false));

  const accountEmailLocal = required('ACCOUNT_EMAIL_LOCAL');
  if (!/^[a-z0-9._+-]+$/i.test(accountEmailLocal)) {
    throw new Error('ACCOUNT_EMAIL_LOCAL has invalid characters');
  }

  const budgetRaw = process.env.MONTHLY_BUDGET_USD?.trim();
  let monthlyBudgetUsd: number | undefined;
  let budgetAlertEmail: string | undefined;
  if (budgetRaw) {
    monthlyBudgetUsd = Number(budgetRaw);
    if (!Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd <= 0) {
      throw new Error('MONTHLY_BUDGET_USD must be a positive number');
    }
    budgetAlertEmail = required('BUDGET_ALERT_EMAIL');
    if (!budgetAlertEmail.includes('@')) {
      throw new Error('BUDGET_ALERT_EMAIL must be an email address');
    }
  }

  return {
    organizationName: required('ORGANIZATION_NAME').toLowerCase(),
    awsRegion: optional('AWS_REGION', 'us-east-1'),
    networkHub: parseBool('NETWORK_HUB', false),
    products,
    environments,
    accountEmailLocal,
    accountEmailDomain,
    ssoPermissionSets: parseBool('SSO_PERMISSION_SETS', true),
    securityBaseline: parseBool('SECURITY_BASELINE', true),
    accountAliases: parseBool('ACCOUNT_ALIASES', true),
    detachRootLeaveScp: parseBool('DETACH_ROOT_LEAVE_SCP', true),
    ssoAssignments: {
      platformAdminUsers: parseOptionalUuidList('SSO_PLATFORM_ADMIN_USERS'),
      platformAdminGroups: parseOptionalUuidList('SSO_PLATFORM_ADMIN_GROUPS'),
      stagingDeveloperUsers: parseOptionalUuidList('SSO_STAGING_DEVELOPER_USERS'),
      stagingDeveloperGroups: parseOptionalUuidList('SSO_STAGING_DEVELOPER_GROUPS'),
      stagingMcpUsers: parseOptionalUuidList('SSO_STAGING_MCP_USERS'),
      stagingMcpGroups: parseOptionalUuidList('SSO_STAGING_MCP_GROUPS'),
      prodReadonlyUsers: parseOptionalUuidList('SSO_PROD_READONLY_USERS'),
      prodReadonlyGroups: parseOptionalUuidList('SSO_PROD_READONLY_GROUPS'),
    },
    monthlyBudgetUsd,
    budgetAlertEmail,
    repoRoot,
  };
}
