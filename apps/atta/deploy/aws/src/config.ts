import * as fs from 'node:fs';
import * as path from 'node:path';
import dotenv from 'dotenv';

const repoRoot = path.resolve(__dirname, '../../../../..');
const envFileRaw = process.env.ENV_FILE?.trim();
const envPath = envFileRaw ? (path.isAbsolute(envFileRaw) ? envFileRaw : path.resolve(repoRoot, envFileRaw)) : path.join(repoRoot, 'apps/atta/.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

export interface InfraConfig {
  envName: string;
  isProd: boolean;
  awsAccountId: string;
  awsRegion: 'us-east-1';
  rootDomain: string;
  appSubdomain: string;
  mediaSubdomain: string;
  apiOriginSubdomain: string;
  appDomain: string;
  mediaDomain: string;
  apiOriginDomain: string;
  cloudflareApiToken: string;
  neonApiKey: string;
  neonProjectId: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiEndpoint: string;
  googleClientId: string;
  googleClientSecret: string;
  microsoftClientId: string;
  microsoftClientSecret: string;
  alarmEmail?: string;
  supportEmail: string;
  termsUrl: string;
  privacyUrl: string;
  licenseLabel: string;
  appEnv: 'local' | 'staging' | 'production';
  repoRoot: string;
  webBuildPath: string;
  lambdaBuildDir: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required in ${process.env.ENV_FILE?.trim() || 'apps/atta/.env'}`);
  }
  return value;
}

function optional(name: string, fallback = ''): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export function loadConfig(): InfraConfig {
  const envName = required('ENV');
  const awsRegion = optional('AWS_REGION', 'us-east-1');
  if (awsRegion !== 'us-east-1') {
    throw new Error('AWS_REGION must be us-east-1 so CloudFront certificates stay in this stack');
  }

  const rootDomain = required('ROOT_DOMAIN');
  const appSubdomain = optional('APP_SUBDOMAIN', 'app');
  const mediaSubdomain = optional('MEDIA_SUBDOMAIN', 'media');
  const apiOriginSubdomain = optional('API_ORIGIN_SUBDOMAIN', 'api');

  return {
    envName,
    isProd: envName === 'prod' || envName === 'production',
    awsAccountId: required('AWS_ACCOUNT_ID'),
    awsRegion: awsRegion as 'us-east-1',
    rootDomain,
    appSubdomain,
    mediaSubdomain,
    apiOriginSubdomain,
    appDomain: `${appSubdomain}.${rootDomain}`,
    mediaDomain: `${mediaSubdomain}.${rootDomain}`,
    apiOriginDomain: `${apiOriginSubdomain}.${rootDomain}`,
    cloudflareApiToken: required('CLOUDFLARE_API_TOKEN'),
    neonApiKey: required('NEON_API_KEY'),
    neonProjectId: required('NEON_PROJECT_ID'),
    geminiApiKey: required('GEMINI_API_KEY'),
    geminiModel: optional('GEMINI_MODEL', 'gemini-2.0-flash'),
    geminiEndpoint: optional('GEMINI_ENDPOINT', 'https://generativelanguage.googleapis.com'),
    googleClientId: optional('GOOGLE_CLIENT_ID'),
    googleClientSecret: optional('GOOGLE_CLIENT_SECRET'),
    microsoftClientId: optional('MICROSOFT_CLIENT_ID'),
    microsoftClientSecret: optional('MICROSOFT_CLIENT_SECRET'),
    alarmEmail: optional('ALARM_EMAIL') || undefined,
    supportEmail: required('SUPPORT_EMAIL'),
    termsUrl: optional('TERMS_URL'),
    privacyUrl: optional('PRIVACY_URL'),
    licenseLabel: optional('LICENSE_LABEL', 'Software propietario'),
    // ENV is the Pulumi stack slug (staging|prod). APP_ENV is the product channel.
    appEnv: (() => {
      if (envName === 'staging') {
        return 'staging' as const;
      }
      if (envName === 'local') {
        return 'local' as const;
      }
      // Existing AWS stacks use ENV=prod; product channel is production.
      if (envName === 'prod' || envName === 'production') {
        return 'production' as const;
      }
      throw new Error('ENV must be local|staging|prod|production');
    })(),
    repoRoot,
    webBuildPath: path.join(repoRoot, 'apps/atta/pwa/dist/pwa/browser'),
    lambdaBuildDir: path.join(__dirname, '..', '.build', 'lambda'),
  };
}

export { defaultTags, resourcePrefix } from './names';
