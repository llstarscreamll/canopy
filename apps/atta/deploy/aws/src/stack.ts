import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as neon from '@pulumi/neon';
import * as random from '@pulumi/random';
import * as cloudflare from '@pulumi/cloudflare';
import type { InfraConfig } from './config';
import { defaultTags, resourcePrefix } from './names';

export interface StackOutputs {
  webUrl: pulumi.Output<string>;
  apiUrl: pulumi.Output<string>;
  ssmParameterName: pulumi.Output<string>;
  neonProjectId: pulumi.Output<string>;
  jobsQueueUrl: pulumi.Output<string>;
  migrateFunctionName: pulumi.Output<string>;
  apiOriginDomain: pulumi.Output<string>;
}

const CLOUDFRONT_CACHE_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const CLOUDFRONT_CACHE_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const CLOUDFRONT_ORIGIN_ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

export function deployStack(cfg: InfraConfig): StackOutputs {
  const prefix = resourcePrefix(cfg.envName);
  const tags = defaultTags(cfg.envName);
  const awsProvider = new aws.Provider('aws', {
    region: cfg.awsRegion,
    allowedAccountIds: [cfg.awsAccountId],
    defaultTags: { tags },
  });
  const neonProvider = new neon.Provider('neon', { apiKey: cfg.neonApiKey });
  const cfProvider = new cloudflare.Provider('cloudflare', { apiToken: cfg.cloudflareApiToken });
  const awsOpts = { provider: awsProvider };
  const cfOpts = { provider: cfProvider };

  const neonProject = neon.getProjectOutput({ id: cfg.neonProjectId }, { provider: neonProvider });

  const key = new aws.kms.Key(
    'app',
    {
      description: `${prefix} application secrets and buckets`,
      enableKeyRotation: true,
      deletionWindowInDays: cfg.isProd ? 30 : 7,
    },
    awsOpts,
  );
  new aws.kms.Alias('app', { name: `alias/${prefix}`, targetKeyId: key.id }, awsOpts);

  const objectsBucket = new aws.s3.Bucket(
    'objects',
    {
      bucket: `${prefix}-${cfg.awsAccountId}-objects`,
      forceDestroy: !cfg.isProd,
    },
    awsOpts,
  );
  hardenBucket('objects', objectsBucket, key.arn, awsOpts, {
    cors: [
      {
        allowedHeaders: ['*'],
        allowedMethods: ['GET', 'PUT', 'HEAD'],
        allowedOrigins: [`https://${cfg.appDomain}`, `https://${cfg.rootDomain}`],
        exposeHeaders: ['ETag'],
        maxAgeSeconds: 3600,
      },
    ],
  });

  const webBucket = new aws.s3.Bucket(
    'web',
    {
      bucket: `${prefix}-${cfg.awsAccountId}-web`,
      forceDestroy: !cfg.isProd,
    },
    awsOpts,
  );
  hardenBucket('web', webBucket, key.arn, awsOpts);

  const jobsDlq = new aws.sqs.Queue(
    'jobs-dlq',
    {
      name: `${prefix}-jobs-dlq`,
      sqsManagedSseEnabled: true,
      messageRetentionSeconds: 14 * 24 * 3600,
    },
    awsOpts,
  );
  const jobsQueue = new aws.sqs.Queue(
    'jobs',
    {
      name: `${prefix}-jobs`,
      sqsManagedSseEnabled: true,
      visibilityTimeoutSeconds: 1080,
      redrivePolicy: jobsDlq.arn.apply((arn) => JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 })),
    },
    awsOpts,
  );

  const lambdaDlq = new aws.sqs.Queue(
    'lambda-dlq',
    {
      name: `${prefix}-lambda-dlq`,
      sqsManagedSseEnabled: true,
      messageRetentionSeconds: 14 * 24 * 3600,
    },
    awsOpts,
  );

  const eventBus = new aws.cloudwatch.EventBus('app', { name: `${prefix}-bus` }, awsOpts);

  const inboxKey = new random.RandomBytes('inbox-key', { length: 32 });
  const tenantKey = new random.RandomBytes('tenant-key', { length: 32 });
  const jwtAccess = new random.RandomPassword('jwt-access', { length: 64, special: false });
  const jwtRefresh = new random.RandomPassword('jwt-refresh', { length: 64, special: false });
  const attestation = new random.RandomPassword('attestation', { length: 64, special: false });
  const originVerify = new random.RandomPassword('origin-verify', { length: 32, special: false });

  const secretString = pulumi
    .all({
      pooled: pulumi.secret(neonProject.connectionUriPooler),
      direct: pulumi.secret(neonProject.connectionUri),
      jobsQueueUrl: jobsQueue.url,
      eventBusName: eventBus.name,
      objectsBucket: objectsBucket.bucket,
      inboxKey: inboxKey.base64,
      tenantKey: tenantKey.base64,
      jwtAccess: jwtAccess.result,
      jwtRefresh: jwtRefresh.result,
      attestation: attestation.result,
    })
    .apply((v) =>
      JSON.stringify({
        app_env: cfg.appEnv,
        database_url: v.pooled,
        database_direct_url: v.direct,
        sqs_queue_url: v.jobsQueueUrl,
        event_bus_name: v.eventBusName,
        s3_bucket_name: v.objectsBucket,
        gemini_api_key: cfg.geminiApiKey,
        gemini_model: cfg.geminiModel,
        gemini_endpoint: cfg.geminiEndpoint,
        google_client_id: cfg.googleClientId,
        google_client_secret: cfg.googleClientSecret,
        microsoft_client_id: cfg.microsoftClientId,
        microsoft_client_secret: cfg.microsoftClientSecret,
        inbox_credentials_encryption_key: v.inboxKey,
        tenant_secrets_encryption_key: v.tenantKey,
        jwt_access_secret: v.jwtAccess,
        jwt_refresh_secret: v.jwtRefresh,
        messaging_attestation_secret: v.attestation,
        allowed_origins: `https://${cfg.appDomain},https://${cfg.rootDomain}`,
        frontend_url: `https://${cfg.appDomain}`,
        backend_url: `https://${cfg.appDomain}`,
        support_email: cfg.supportEmail,
        terms_url: cfg.termsUrl,
        privacy_url: cfg.privacyUrl,
        license_label: cfg.licenseLabel,
      }),
    );

  const secretsParam = new aws.ssm.Parameter(
    'app',
    {
      name: `/atta/${cfg.envName}/secrets`,
      type: 'SecureString',
      keyId: key.arn,
      tier: 'Standard',
      value: secretString,
    },
    { ...awsOpts, protect: true },
  );

  const lambdaEnv = {
    DEPLOYMENT_TARGET: 'aws',
    APP_ENV: cfg.appEnv,
    AWS_REGION: cfg.awsRegion,
    SSM_PARAMETER_NAME: secretsParam.name,
    TENANT_MIGRATIONS_DIR: 'migrations/tenant',
    ALLOWED_ORIGINS: `https://${cfg.appDomain},https://${cfg.rootDomain}`,
    FRONTEND_URL: `https://${cfg.appDomain}`,
    BACKEND_URL: `https://${cfg.appDomain}`,
    SUPPORT_EMAIL: cfg.supportEmail,
    TERMS_URL: cfg.termsUrl,
    PRIVACY_URL: cfg.privacyUrl,
    LICENSE_LABEL: cfg.licenseLabel,
  };

  const migrateFn = goLambda(cfg, prefix, 'migrate', 'migrate', key, secretsParam, lambdaDlq, lambdaEnv, awsOpts, {
    timeout: 120,
    memory: 512,
    extraStatements: [kmsDecrypt(key.arn)],
    includeMigrations: true,
  });
  const migrateRun = new aws.lambda.Invocation(
    'schema',
    {
      functionName: migrateFn.name,
      input: '{}',
      triggers: {
        code: migrateFn.sourceCodeHash,
      },
    },
    { ...awsOpts, dependsOn: [migrateFn, secretsParam] },
  );
  const afterSchema: AwsOpts = { ...awsOpts, dependsOn: [migrateRun] };

  const httpFn = goLambda(cfg, prefix, 'http', 'http', key, secretsParam, lambdaDlq, lambdaEnv, afterSchema, {
    timeout: 29,
    memory: 512,
    extraStatements: [s3ObjectsPolicy(objectsBucket.arn), kmsDecrypt(key.arn)],
    includeMigrations: true,
  });
  const jobsFn = goLambda(cfg, prefix, 'sqs', 'jobs', key, secretsParam, lambdaDlq, lambdaEnv, afterSchema, {
    timeout: 900,
    memory: 1024,
    ephemeralMb: 1024,
    extraStatements: [s3ObjectsPolicy(objectsBucket.arn), sqsConsume(jobsQueue.arn), kmsDecrypt(key.arn)],
  });
  const eventsFn = goLambda(cfg, prefix, 'eventbridge', 'events', key, secretsParam, lambdaDlq, lambdaEnv, afterSchema, {
    timeout: 30,
    memory: 512,
    extraStatements: [s3ObjectsPolicy(objectsBucket.arn), kmsDecrypt(key.arn)],
  });
  const relayFn = goLambda(cfg, prefix, 'outbox-relay', 'outbox-relay', key, secretsParam, lambdaDlq, lambdaEnv, afterSchema, {
    timeout: 60,
    memory: 512,
    extraStatements: [allowEventBridge(eventBus.arn), allowSqsSend(jobsQueue.arn), kmsDecrypt(key.arn)],
  });
  const schedulerFn = goLambda(cfg, prefix, 'scheduler', 'scheduler', key, secretsParam, lambdaDlq, lambdaEnv, afterSchema, {
    timeout: 60,
    memory: 512,
    extraStatements: [allowEventBridge(eventBus.arn), allowSqsSend(jobsQueue.arn), kmsDecrypt(key.arn)],
  });

  new aws.lambda.EventSourceMapping(
    'jobs',
    {
      eventSourceArn: jobsQueue.arn,
      functionName: jobsFn.name,
      batchSize: 1,
    },
    awsOpts,
  );

  const appRule = new aws.cloudwatch.EventRule(
    'app-events',
    {
      name: `${prefix}-app-events`,
      eventBusName: eventBus.name,
      eventPattern: JSON.stringify({ source: [{ prefix: 'atta.' }] }),
    },
    awsOpts,
  );
  new aws.cloudwatch.EventTarget('app-events', { rule: appRule.name, eventBusName: eventBus.name, arn: eventsFn.arn }, awsOpts);
  new aws.lambda.Permission(
    'events-bus',
    {
      action: 'lambda:InvokeFunction',
      function: eventsFn.name,
      principal: 'events.amazonaws.com',
      sourceArn: appRule.arn,
    },
    awsOpts,
  );

  const schedulerRole = new aws.iam.Role(
    'scheduler',
    {
      name: `${prefix}-scheduler-invoke`,
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'scheduler.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      }),
    },
    awsOpts,
  );
  new aws.iam.RolePolicy(
    'scheduler-invoke',
    {
      role: schedulerRole.id,
      policy: pulumi.all([relayFn.arn, schedulerFn.arn, lambdaDlq.arn]).apply(([relayArn, schedArn, dlqArn]) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: [relayArn, schedArn] },
            { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: dlqArn },
          ],
        }),
      ),
    },
    awsOpts,
  );

  scheduleLambda(prefix, 'outbox-relay', 'rate(1 minute)', relayFn.arn, schedulerRole.arn, '{}', lambdaDlq.arn, awsOpts);
  scheduleLambda(prefix, 'outbox-sweeper', 'rate(1 hour)', schedulerFn.arn, schedulerRole.arn, JSON.stringify({ ruleName: 'outbox-sweeper' }), lambdaDlq.arn, awsOpts);
  scheduleLambda(prefix, 'catalog-import-purge', 'cron(0 5 * * ? *)', schedulerFn.arn, schedulerRole.arn, JSON.stringify({ ruleName: 'catalog-import-purge' }), lambdaDlq.arn, awsOpts);
  const mailSyncEnabled = (Boolean(cfg.googleClientId) && Boolean(cfg.googleClientSecret)) || (Boolean(cfg.microsoftClientId) && Boolean(cfg.microsoftClientSecret));
  if (mailSyncEnabled) {
    scheduleLambda(prefix, 'inbox-sync-all', 'rate(5 minutes)', schedulerFn.arn, schedulerRole.arn, JSON.stringify({ ruleName: 'inbox-sync-all' }), lambdaDlq.arn, awsOpts);
  }

  const cert = new aws.acm.Certificate(
    'edge',
    {
      domainName: cfg.rootDomain,
      subjectAlternativeNames: [cfg.appDomain, cfg.mediaDomain, cfg.apiOriginDomain],
      validationMethod: 'DNS',
    },
    awsOpts,
  );

  const zone = cloudflare.getZoneOutput({ name: cfg.rootDomain }, { provider: cfProvider });
  const validationDomains = [cfg.rootDomain, cfg.appDomain, cfg.mediaDomain, cfg.apiOriginDomain];
  const validationRecords = validationDomains.map((domain, i) => {
    const dvo = cert.domainValidationOptions.apply((opts) => opts.find((o) => o.domainName === domain) ?? opts[0]);
    return new cloudflare.Record(
      `acm-${i}`,
      {
        zoneId: zone.id,
        name: dvo.apply((d) => dnsRelativeName(d.resourceRecordName, cfg.rootDomain)),
        type: dvo.apply((d) => d.resourceRecordType),
        content: dvo.apply((d) => d.resourceRecordValue.replace(/\.$/, '')),
        ttl: 60,
        proxied: false,
        allowOverwrite: true,
      },
      cfOpts,
    );
  });

  const certValidation = new aws.acm.CertificateValidation(
    'edge',
    {
      certificateArn: cert.arn,
      validationRecordFqdns: validationRecords.map((r) => r.hostname),
    },
    awsOpts,
  );

  const httpApi = new aws.apigatewayv2.Api(
    'http',
    {
      name: `${prefix}-http`,
      protocolType: 'HTTP',
      disableExecuteApiEndpoint: true,
    },
    awsOpts,
  );
  const integration = new aws.apigatewayv2.Integration(
    'http-proxy',
    {
      apiId: httpApi.id,
      integrationType: 'AWS_PROXY',
      integrationUri: httpFn.invokeArn,
      payloadFormatVersion: '2.0',
      timeoutMilliseconds: 29000,
    },
    awsOpts,
  );
  new aws.apigatewayv2.Route(
    'http-default',
    {
      apiId: httpApi.id,
      routeKey: '$default',
      target: pulumi.interpolate`integrations/${integration.id}`,
    },
    awsOpts,
  );
  const apiLogGroup = new aws.cloudwatch.LogGroup('http-api', { name: `/aws/apigateway/${prefix}`, retentionInDays: cfg.isProd ? 90 : 30 }, awsOpts);
  const apiStage = new aws.apigatewayv2.Stage(
    'http-default',
    {
      apiId: httpApi.id,
      name: '$default',
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: apiLogGroup.arn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          status: '$context.status',
          route: '$context.routeKey',
          error: '$context.error.message',
        }),
      },
      defaultRouteSettings: {
        throttlingBurstLimit: 200,
        throttlingRateLimit: 100,
      },
    },
    awsOpts,
  );
  new aws.lambda.Permission(
    'http-api',
    {
      action: 'lambda:InvokeFunction',
      function: httpFn.name,
      principal: 'apigateway.amazonaws.com',
      sourceArn: pulumi.interpolate`${httpApi.executionArn}/*/*`,
    },
    awsOpts,
  );

  const apiDomain = new aws.apigatewayv2.DomainName(
    'api',
    {
      domainName: cfg.apiOriginDomain,
      domainNameConfiguration: {
        certificateArn: certValidation.certificateArn,
        endpointType: 'REGIONAL',
        securityPolicy: 'TLS_1_2',
      },
    },
    awsOpts,
  );
  const apiMapping = new aws.apigatewayv2.ApiMapping(
    'api',
    {
      apiId: httpApi.id,
      domainName: apiDomain.domainName,
      stage: apiStage.name,
    },
    awsOpts,
  );
  const apiOriginDns = dnsRecord(
    cfOpts,
    zone.id,
    cfg.apiOriginSubdomain,
    'CNAME',
    apiDomain.domainNameConfiguration.apply((config) => {
      const entry = Array.isArray(config) ? config[0] : config;
      return entry.targetDomainName;
    }),
  );

  const oac = new aws.cloudfront.OriginAccessControl(
    'web',
    {
      name: `${prefix}-web-oac`,
      originAccessControlOriginType: 's3',
      signingBehavior: 'always',
      signingProtocol: 'sigv4',
    },
    awsOpts,
  );

  const responseHeaders = new aws.cloudfront.ResponseHeadersPolicy(
    'spa',
    {
      name: `${prefix}-spa-headers`,
      securityHeadersConfig: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'nonce-atta'; style-src 'self' 'nonce-atta' https://cdn.jsdelivr.net; style-src-attr 'unsafe-inline'; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: https:; connect-src 'self' https://${cfg.mediaDomain}; frame-src 'self' blob:; form-action 'self'`,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: 'DENY' },
        referrerPolicy: { override: true, referrerPolicy: 'strict-origin-when-cross-origin' },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAgeSec: 31536000,
          includeSubdomains: true,
          preload: true,
        },
      },
      customHeadersConfig: {
        items: [
          { header: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()', override: true },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
          { header: 'Cross-Origin-Embedder-Policy', value: 'credentialless', override: true },
          { header: 'Cross-Origin-Resource-Policy', value: 'same-origin', override: true },
        ],
      },
    },
    awsOpts,
  );

  const spaFallback = new aws.cloudfront.Function(
    'spa-fallback',
    {
      name: `${prefix}-spa-fallback`,
      runtime: 'cloudfront-js-2.0',
      publish: true,
      comment: 'Rewrite SPA routes to /index.html; /api stays on the API origin',
      code: `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/api' || uri.startsWith('/api/')) {
    return request;
  }
  if (uri.includes('.')) {
    return request;
  }
  request.uri = '/index.html';
  return request;
}
`,
    },
    awsOpts,
  );

  const webAcl = spaWebAcl(prefix, awsOpts);
  const distribution = new aws.cloudfront.Distribution(
    'web',
    {
      enabled: true,
      comment: `${prefix}-web`,
      aliases: [cfg.rootDomain, cfg.appDomain],
      defaultRootObject: 'index.html',
      httpVersion: 'http2and3',
      priceClass: 'PriceClass_100',
      webAclId: webAcl.arn,
      origins: [
        {
          originId: 'web',
          domainName: webBucket.bucketRegionalDomainName,
          originAccessControlId: oac.id,
        },
        {
          originId: 'api',
          domainName: cfg.apiOriginDomain,
          customHeaders: [{ name: 'X-Origin-Verify', value: originVerify.result }],
          customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: 'https-only',
            originSslProtocols: ['TLSv1.2'],
          },
        },
      ],
      orderedCacheBehaviors: [cloudFrontApiBehavior('/api*')],
      defaultCacheBehavior: {
        targetOriginId: 'web',
        viewerProtocolPolicy: 'redirect-to-https',
        allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
        cachedMethods: ['GET', 'HEAD'],
        compress: true,
        cachePolicyId: CLOUDFRONT_CACHE_OPTIMIZED,
        responseHeadersPolicyId: responseHeaders.id,
        functionAssociations: [{ eventType: 'viewer-request', functionArn: spaFallback.arn }],
      },
      restrictions: { geoRestriction: { restrictionType: 'none' } },
      viewerCertificate: {
        acmCertificateArn: certValidation.certificateArn,
        sslSupportMethod: 'sni-only',
        minimumProtocolVersion: 'TLSv1.2_2021',
      },
    },
    { ...awsOpts, dependsOn: [apiMapping, apiOriginDns] },
  );

  new aws.kms.KeyPolicy(
    'app',
    {
      keyId: key.id,
      policy: pulumi.all([distribution.arn, cfg.awsAccountId]).apply(([distArn, account]) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'EnableIamUserPermissions',
              Effect: 'Allow',
              Principal: { AWS: `arn:aws:iam::${account}:root` },
              Action: 'kms:*',
              Resource: '*',
            },
            {
              Sid: 'AllowCloudFrontServicePrincipalSSE-KMS',
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*'],
              Resource: '*',
              Condition: { StringEquals: { 'AWS:SourceArn': distArn } },
            },
          ],
        }),
      ),
    },
    awsOpts,
  );

  new aws.s3.BucketPolicy(
    'web-oac',
    {
      bucket: webBucket.id,
      policy: pulumi.all([webBucket.arn, distribution.arn]).apply(([bucketArn, distArn]) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'AllowCloudFront',
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 's3:GetObject',
              Resource: `${bucketArn}/*`,
              Condition: { StringEquals: { 'AWS:SourceArn': distArn } },
            },
          ],
        }),
      ),
    },
    awsOpts,
  );

  syncWebAssets(cfg, webBucket, distribution, afterSchema);

  const apiWaf = apiWebAcl(prefix, originVerify.result, awsOpts);
  new aws.wafv2.WebAclAssociation(
    'http-api',
    {
      resourceArn: pulumi.interpolate`arn:aws:apigateway:${cfg.awsRegion}::/apis/${httpApi.id}/stages/${apiStage.name}`,
      webAclArn: apiWaf.arn,
    },
    awsOpts,
  );

  dnsRecord(cfOpts, zone.id, cfg.appSubdomain, 'CNAME', distribution.domainName);
  dnsRecord(cfOpts, zone.id, '@', 'CNAME', distribution.domainName);

  alarms(
    prefix,
    [
      ['http', httpFn],
      ['jobs', jobsFn],
      ['events', eventsFn],
      ['outbox-relay', relayFn],
      ['scheduler', schedulerFn],
    ],
    [
      ['jobs-dlq', jobsDlq],
      ['lambda-dlq', lambdaDlq],
    ],
    cfg,
    awsOpts,
  );

  return {
    webUrl: pulumi.interpolate`https://${cfg.appDomain}`,
    apiUrl: pulumi.interpolate`https://${cfg.appDomain}`,
    ssmParameterName: secretsParam.name,
    neonProjectId: pulumi.output(cfg.neonProjectId),
    jobsQueueUrl: jobsQueue.url,
    migrateFunctionName: migrateFn.name,
    apiOriginDomain: pulumi.output(cfg.apiOriginDomain),
  };
}

type AwsOpts = { provider: aws.Provider; dependsOn?: pulumi.Resource[] };

function cloudFrontApiBehavior(pathPattern: string): aws.types.input.cloudfront.DistributionOrderedCacheBehavior {
  return {
    pathPattern,
    targetOriginId: 'api',
    viewerProtocolPolicy: 'redirect-to-https',
    allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    cachedMethods: ['GET', 'HEAD'],
    compress: true,
    cachePolicyId: CLOUDFRONT_CACHE_DISABLED,
    originRequestPolicyId: CLOUDFRONT_ORIGIN_ALL_VIEWER_EXCEPT_HOST,
  };
}

function hardenBucket(name: string, bucket: aws.s3.Bucket, keyArn: pulumi.Input<string>, opts: AwsOpts, extra?: { cors?: aws.types.input.s3.BucketCorsConfigurationV2CorsRule[] }): void {
  new aws.s3.BucketPublicAccessBlock(
    `${name}-pab`,
    {
      bucket: bucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    },
    opts,
  );
  new aws.s3.BucketServerSideEncryptionConfigurationV2(
    `${name}-sse`,
    {
      bucket: bucket.id,
      rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'aws:kms', kmsMasterKeyId: keyArn }, bucketKeyEnabled: true }],
    },
    opts,
  );
  new aws.s3.BucketVersioningV2(`${name}-ver`, { bucket: bucket.id, versioningConfiguration: { status: 'Enabled' } }, opts);
  new aws.s3.BucketOwnershipControls(`${name}-own`, { bucket: bucket.id, rule: { objectOwnership: 'BucketOwnerEnforced' } }, opts);
  new aws.s3.BucketLifecycleConfigurationV2(
    `${name}-lc`,
    {
      bucket: bucket.id,
      rules: [
        {
          id: 'abort-incomplete-mpu',
          status: 'Enabled',
          filter: { prefix: '' },
          abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
        },
      ],
    },
    opts,
  );
  if (extra?.cors) {
    new aws.s3.BucketCorsConfigurationV2(`${name}-cors`, { bucket: bucket.id, corsRules: extra.cors }, opts);
  }
}

function goLambda(
  cfg: InfraConfig,
  prefix: string,
  entry: string,
  name: string,
  key: aws.kms.Key,
  secretsParam: aws.ssm.Parameter,
  dlq: aws.sqs.Queue,
  environment: Record<string, pulumi.Input<string>>,
  opts: AwsOpts,
  args: {
    timeout: number;
    memory: number;
    ephemeralMb?: number;
    extraStatements: pulumi.Input<unknown>[];
    includeMigrations?: boolean;
  },
): aws.lambda.Function {
  const dir = path.join(cfg.lambdaBuildDir, entry);
  const bootstrap = path.join(dir, 'bootstrap');
  if (!fs.existsSync(bootstrap)) {
    if (!pulumi.runtime.isDryRun()) {
      throw new Error(`Lambda artifact missing: ${bootstrap}. Run pnpm --filter @atta/infra build:lambdas`);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(bootstrap, '');
  }
  const { dependsOn, ...baseOpts } = opts;
  const role = new aws.iam.Role(
    `${name}-role`,
    {
      name: `${prefix}-${name}`,
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      }),
    },
    baseOpts,
  );
  const policy = pulumi.all([secretsParam.arn, key.arn, dlq.arn, ...args.extraStatements]).apply((values) => {
    const parameterArn = values[0] as string;
    const keyArn = values[1] as string;
    const dlqArn = values[2] as string;
    const extra = values.slice(3) as Record<string, unknown>[];
    return JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource: `arn:aws:logs:${cfg.awsRegion}:${cfg.awsAccountId}:log-group:/aws/lambda/${prefix}-${name}:*`,
        },
        { Effect: 'Allow', Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], Resource: '*' },
        { Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters'], Resource: parameterArn },
        { Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey'], Resource: keyArn },
        { Effect: 'Allow', Action: ['sqs:SendMessage'], Resource: dlqArn },
        ...extra,
      ],
    });
  });
  new aws.iam.RolePolicy(`${name}-policy`, { role: role.id, policy }, baseOpts);

  new aws.cloudwatch.LogGroup(`${name}-logs`, { name: `/aws/lambda/${prefix}-${name}`, retentionInDays: cfg.isProd ? 90 : 30 }, baseOpts);

  const archiveDir = fs.existsSync(dir) ? dir : cfg.lambdaBuildDir;
  return new aws.lambda.Function(
    name,
    {
      name: `${prefix}-${name}`,
      role: role.arn,
      runtime: 'provided.al2023',
      handler: 'bootstrap',
      architectures: ['arm64'],
      timeout: args.timeout,
      memorySize: args.memory,
      ephemeralStorage: args.ephemeralMb ? { size: args.ephemeralMb } : undefined,
      tracingConfig: { mode: 'Active' },
      deadLetterConfig: { targetArn: dlq.arn },
      environment: { variables: environment },
      code: new pulumi.asset.FileArchive(archiveDir),
      kmsKeyArn: key.arn,
    },
    { ...baseOpts, dependsOn },
  );
}

function scheduleLambda(
  prefix: string,
  name: string,
  expression: string,
  fnArn: pulumi.Input<string>,
  roleArn: pulumi.Input<string>,
  input: string,
  dlqArn: pulumi.Input<string>,
  opts: AwsOpts,
): void {
  new aws.scheduler.Schedule(
    name,
    {
      name: `${prefix}-${name}`,
      scheduleExpression: expression,
      flexibleTimeWindow: { mode: 'OFF' },
      target: { arn: fnArn, roleArn, input, deadLetterConfig: { arn: dlqArn } },
    },
    opts,
  );
}

function s3ObjectsPolicy(bucketArn: pulumi.Input<string>): pulumi.Output<Record<string, unknown>> {
  return pulumi.output(bucketArn).apply((arn) => ({
    Effect: 'Allow',
    Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListBucket'],
    Resource: [arn, `${arn}/*`],
  })) as unknown as pulumi.Output<Record<string, unknown>>;
}

function sqsConsume(queueArn: pulumi.Input<string>): pulumi.Output<Record<string, unknown>> {
  return pulumi.output(queueArn).apply((arn) => ({
    Effect: 'Allow',
    Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ChangeMessageVisibility'],
    Resource: arn,
  })) as unknown as pulumi.Output<Record<string, unknown>>;
}

function allowSqsSend(queueArn: pulumi.Input<string>): pulumi.Output<Record<string, unknown>> {
  return pulumi.output(queueArn).apply((arn) => ({
    Effect: 'Allow',
    Action: ['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
    Resource: arn,
  })) as unknown as pulumi.Output<Record<string, unknown>>;
}

function allowEventBridge(busArn: pulumi.Input<string>): pulumi.Output<Record<string, unknown>> {
  return pulumi.output(busArn).apply((arn) => ({
    Effect: 'Allow',
    Action: ['events:PutEvents'],
    Resource: arn,
  })) as unknown as pulumi.Output<Record<string, unknown>>;
}

function kmsDecrypt(keyArn: pulumi.Input<string>): pulumi.Output<Record<string, unknown>> {
  return pulumi.output(keyArn).apply((arn) => ({
    Effect: 'Allow',
    Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
    Resource: arn,
  })) as unknown as pulumi.Output<Record<string, unknown>>;
}

function spaWebAcl(prefix: string, opts: AwsOpts): aws.wafv2.WebAcl {
  return new aws.wafv2.WebAcl(
    'cdn',
    {
      name: `${prefix}-cdn`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudwatchMetricsEnabled: true, metricName: `${prefix}-cdn`, sampledRequestsEnabled: true },
      rules: managedWafRules(),
    },
    opts,
  );
}

function apiWebAcl(prefix: string, originVerify: pulumi.Input<string>, opts: AwsOpts): aws.wafv2.WebAcl {
  return new aws.wafv2.WebAcl(
    'api',
    {
      name: `${prefix}-api`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudwatchMetricsEnabled: true, metricName: `${prefix}-api`, sampledRequestsEnabled: true },
      rules: pulumi.output(originVerify).apply((secret): aws.types.input.wafv2.WebAclRule[] => [
        {
          name: 'RequireOriginVerify',
          priority: 0,
          action: { block: {} },
          statement: {
            notStatement: {
              statements: [
                {
                  byteMatchStatement: {
                    positionalConstraint: 'EXACTLY',
                    searchString: secret,
                    fieldToMatch: { singleHeader: { name: 'x-origin-verify' } },
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            cloudwatchMetricsEnabled: true,
            metricName: `${prefix}-origin-verify`,
            sampledRequestsEnabled: true,
          },
        },
        ...managedWafRules(),
      ]),
    },
    opts,
  );
}

function managedWafRules(): aws.types.input.wafv2.WebAclRule[] {
  const names = ['AWSManagedRulesAmazonIpReputationList', 'AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet', 'AWSManagedRulesSQLiRuleSet'];
  return names.map((name, i) => ({
    name,
    priority: i + 1,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { name, vendorName: 'AWS' } },
    visibilityConfig: { cloudwatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true },
  }));
}

function dnsRecord(opts: { provider: cloudflare.Provider }, zoneId: pulumi.Input<string>, name: string, type: string, content: pulumi.Input<string>): cloudflare.Record {
  return new cloudflare.Record(
    `dns-${name === '@' ? 'apex' : name}`,
    {
      zoneId,
      name,
      type,
      content,
      proxied: false,
      ttl: 300,
      allowOverwrite: true,
    },
    opts,
  );
}

function dnsRelativeName(fqdn: string, zone: string): string {
  const trimmed = fqdn.replace(/\.$/, '');
  if (trimmed === zone) {
    return '@';
  }
  const suffix = `.${zone}`;
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
}

function syncWebAssets(cfg: InfraConfig, bucket: aws.s3.Bucket, distribution: aws.cloudfront.Distribution, opts: AwsOpts): void {
  if (!fs.existsSync(cfg.webBuildPath)) {
    return;
  }
  const hashed: string[] = [];
  const entry: string[] = [];
  walkFiles(cfg.webBuildPath, cfg.webBuildPath, hashed, entry);
  for (const rel of hashed) {
    new aws.s3.BucketObjectv2(
      `web-${rel.replace(/[^A-Za-z0-9]+/g, '-')}`,
      {
        bucket: bucket.id,
        key: rel,
        source: new pulumi.asset.FileAsset(path.join(cfg.webBuildPath, rel)),
        contentType: contentTypeFor(rel),
        cacheControl: 'public, max-age=31536000, immutable',
      },
      opts,
    );
  }
  const entryKeys = ['index.html', 'ngsw.json', 'ngsw-worker.js', 'safety-worker.js', 'manifest.webmanifest'];
  for (const rel of entryKeys) {
    const full = path.join(cfg.webBuildPath, rel);
    if (!fs.existsSync(full)) {
      continue;
    }
    new aws.s3.BucketObjectv2(
      `web-entry-${rel}`,
      {
        bucket: bucket.id,
        key: rel,
        source: new pulumi.asset.FileAsset(full),
        contentType: contentTypeFor(rel),
        cacheControl: 'public, max-age=0, must-revalidate, s-maxage=300',
      },
      opts,
    );
  }
}

function walkFiles(root: string, current: string, hashed: string[], entry: string[]): void {
  const entryNames = new Set(['index.html', 'ngsw.json', 'ngsw-worker.js', 'safety-worker.js', 'manifest.webmanifest']);
  for (const name of fs.readdirSync(current)) {
    const full = path.join(current, name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (fs.statSync(full).isDirectory()) {
      walkFiles(root, full, hashed, entry);
      continue;
    }
    if (entryNames.has(rel)) {
      entry.push(rel);
    } else {
      hashed.push(rel);
    }
  }
}

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
  };
  return map[ext] ?? 'application/octet-stream';
}

function alarms(prefix: string, fns: Array<[string, aws.lambda.Function]>, queues: Array<[string, aws.sqs.Queue]>, cfg: InfraConfig, opts: AwsOpts): void {
  const topic = new aws.sns.Topic('alarms', { name: `${prefix}-alarms` }, opts);
  if (cfg.alarmEmail) {
    new aws.sns.TopicSubscription('alarms-email', { topic: topic.arn, protocol: 'email', endpoint: cfg.alarmEmail }, opts);
  }
  for (const [name, fn] of fns) {
    for (const metricName of ['Errors', 'Throttles'] as const) {
      new aws.cloudwatch.MetricAlarm(
        `${name}-${metricName.toLowerCase()}`,
        {
          name: `${prefix}-${name}-${metricName.toLowerCase()}`,
          comparisonOperator: 'GreaterThanThreshold',
          evaluationPeriods: 1,
          metricName,
          namespace: 'AWS/Lambda',
          period: 60,
          statistic: 'Sum',
          threshold: 0,
          treatMissingData: 'notBreaching',
          alarmActions: [topic.arn],
          dimensions: { FunctionName: fn.name },
        },
        opts,
      );
    }
  }
  for (const [name, dlq] of queues) {
    new aws.cloudwatch.MetricAlarm(
      `${name}-visible`,
      {
        name: `${prefix}-${name}-visible`,
        comparisonOperator: 'GreaterThanThreshold',
        evaluationPeriods: 1,
        metricName: 'ApproximateNumberOfMessagesVisible',
        namespace: 'AWS/SQS',
        period: 60,
        statistic: 'Maximum',
        threshold: 0,
        treatMissingData: 'notBreaching',
        alarmActions: [topic.arn],
        dimensions: { QueueName: dlq.name },
      },
      opts,
    );
  }
}
