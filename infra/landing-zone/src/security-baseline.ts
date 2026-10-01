import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { LandingZoneConfig } from './config';

export interface SecurityBaselineArgs {
  cfg: LandingZoneConfig;
  nameSuffix: string;
  managementProvider: aws.Provider;
  organizationId: pulumi.Input<string>;
  managementAccountId: pulumi.Input<string>;
  logArchiveAccountId: pulumi.Input<string>;
  securityToolingAccountId: pulumi.Input<string>;
}

/**
 * Org CloudTrail (immutable-ish archive in log-archive) + GuardDuty delegated
 * admin in security-tooling + optional management-account monthly budget.
 */
export function wireSecurityBaseline(args: SecurityBaselineArgs): {
  trailArn: pulumi.Output<string>;
  trailBucketName: pulumi.Output<string>;
} {
  const { cfg, managementProvider, organizationId } = args;
  const n = (base: string) => `${base}${args.nameSuffix}`;
  const mgmtOpts: pulumi.ResourceOptions = { provider: managementProvider };

  // EnableOrganizationAdminAccount / org trails require Organizations trusted access.
  const guarddutyOrgAccess = new aws.organizations.AwsServiceAccess(n('org-access-guardduty'), { servicePrincipal: 'guardduty.amazonaws.com' }, mgmtOpts);
  const cloudtrailOrgAccess = new aws.organizations.AwsServiceAccess(n('org-access-cloudtrail'), { servicePrincipal: 'cloudtrail.amazonaws.com' }, mgmtOpts);

  const logArchiveProvider = new aws.Provider(n('provider-log-archive'), {
    region: cfg.awsRegion as aws.Region,
    assumeRoles: [
      {
        roleArn: pulumi.interpolate`arn:aws:iam::${args.logArchiveAccountId}:role/OrganizationAccountAccessRole`,
        sessionName: 'landing-zone-log-archive',
      },
    ],
  });
  const logOpts: pulumi.ResourceOptions = { provider: logArchiveProvider };

  const securityToolingProvider = new aws.Provider(n('provider-security-tooling'), {
    region: cfg.awsRegion as aws.Region,
    assumeRoles: [
      {
        roleArn: pulumi.interpolate`arn:aws:iam::${args.securityToolingAccountId}:role/OrganizationAccountAccessRole`,
        sessionName: 'landing-zone-security-tooling',
      },
    ],
  });
  const secOpts: pulumi.ResourceOptions = { provider: securityToolingProvider };

  const trailBucket = new aws.s3.BucketV2(
    n('org-trail-bucket'),
    {
      bucket: pulumi.interpolate`${cfg.organizationName}-org-cloudtrail-${args.logArchiveAccountId}`,
      forceDestroy: false,
      tags: {
        ManagedBy: 'landing-zone',
        Organization: cfg.organizationName,
        Purpose: 'org-cloudtrail',
      },
    },
    logOpts,
  );

  new aws.s3.BucketOwnershipControls(
    n('org-trail-bucket-ownership'),
    {
      bucket: trailBucket.id,
      rule: { objectOwnership: 'BucketOwnerPreferred' },
    },
    logOpts,
  );

  new aws.s3.BucketPublicAccessBlock(
    n('org-trail-bucket-pab'),
    {
      bucket: trailBucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    },
    logOpts,
  );

  new aws.s3.BucketVersioningV2(
    n('org-trail-bucket-versioning'),
    {
      bucket: trailBucket.id,
      versioningConfiguration: { status: 'Enabled' },
    },
    logOpts,
  );

  new aws.s3.BucketServerSideEncryptionConfigurationV2(
    n('org-trail-bucket-sse'),
    {
      bucket: trailBucket.id,
      rules: [
        {
          applyServerSideEncryptionByDefault: {
            sseAlgorithm: 'AES256',
          },
          bucketKeyEnabled: true,
        },
      ],
    },
    logOpts,
  );

  new aws.s3.BucketLifecycleConfigurationV2(
    n('org-trail-bucket-lifecycle'),
    {
      bucket: trailBucket.id,
      rules: [
        {
          id: 'retain-and-transition',
          status: 'Enabled',
          transitions: [
            { days: 90, storageClass: 'STANDARD_IA' },
            { days: 365, storageClass: 'GLACIER' },
          ],
          noncurrentVersionExpiration: { noncurrentDays: 365 },
        },
      ],
    },
    logOpts,
  );

  const trailName = `${cfg.organizationName}-org-trail`;

  const bucketPolicy = new aws.s3.BucketPolicy(
    n('org-trail-bucket-policy'),
    {
      bucket: trailBucket.id,
      policy: pulumi.all([trailBucket.arn, organizationId, args.managementAccountId]).apply(([bucketArn, orgId, mgmtAcct]) => {
        const trailArn = `arn:aws:cloudtrail:${cfg.awsRegion}:${mgmtAcct}:trail/${trailName}`;
        return JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'AWSCloudTrailAclCheck',
              Effect: 'Allow',
              Principal: { Service: 'cloudtrail.amazonaws.com' },
              Action: 's3:GetBucketAcl',
              Resource: bucketArn,
              Condition: {
                StringEquals: { 'aws:SourceArn': trailArn },
              },
            },
            {
              Sid: 'AWSCloudTrailWrite',
              Effect: 'Allow',
              Principal: { Service: 'cloudtrail.amazonaws.com' },
              Action: 's3:PutObject',
              Resource: `${bucketArn}/AWSLogs/${mgmtAcct}/*`,
              Condition: {
                StringEquals: {
                  's3:x-amz-acl': 'bucket-owner-full-control',
                  'aws:SourceArn': trailArn,
                },
              },
            },
            {
              Sid: 'AWSCloudTrailWriteOrg',
              Effect: 'Allow',
              Principal: { Service: 'cloudtrail.amazonaws.com' },
              Action: 's3:PutObject',
              Resource: `${bucketArn}/AWSLogs/${orgId}/*`,
              Condition: {
                StringEquals: {
                  's3:x-amz-acl': 'bucket-owner-full-control',
                  'aws:SourceArn': trailArn,
                },
              },
            },
            {
              Sid: 'DenyInsecureTransport',
              Effect: 'Deny',
              Principal: '*',
              Action: 's3:*',
              Resource: [bucketArn, `${bucketArn}/*`],
              Condition: {
                Bool: { 'aws:SecureTransport': 'false' },
              },
            },
          ],
        });
      }),
    },
    logOpts,
  );

  const trail = new aws.cloudtrail.Trail(
    n('org-trail'),
    {
      name: trailName,
      s3BucketName: trailBucket.id,
      isOrganizationTrail: true,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableLogFileValidation: true,
      enableLogging: true,
      tags: {
        ManagedBy: 'landing-zone',
        Organization: cfg.organizationName,
      },
    },
    { ...mgmtOpts, dependsOn: [bucketPolicy, cloudtrailOrgAccess] },
  );

  // Detector before org admin (new member accounts need a short settle window).
  const detector = new aws.guardduty.Detector(
    n('guardduty-detector'),
    {
      enable: true,
      findingPublishingFrequency: 'FIFTEEN_MINUTES',
      tags: {
        ManagedBy: 'landing-zone',
        Organization: cfg.organizationName,
      },
    },
    {
      ...secOpts,
      dependsOn: [guarddutyOrgAccess],
      customTimeouts: { create: '15m' },
    },
  );

  const guarddutyOrgAdmin = new aws.guardduty.OrganizationAdminAccount(
    n('guardduty-org-admin'),
    { adminAccountId: args.securityToolingAccountId },
    {
      ...mgmtOpts,
      dependsOn: [guarddutyOrgAccess, detector],
      customTimeouts: { create: '15m' },
    },
  );

  new aws.guardduty.OrganizationConfiguration(
    n('guardduty-org-config'),
    {
      detectorId: detector.id,
      autoEnableOrganizationMembers: 'ALL',
    },
    { ...secOpts, dependsOn: [guarddutyOrgAdmin] },
  );

  if (cfg.monthlyBudgetUsd != null && cfg.budgetAlertEmail) {
    new aws.budgets.Budget(
      n('monthly-cost-budget'),
      {
        name: `${cfg.organizationName}-monthly-cost`,
        budgetType: 'COST',
        limitAmount: String(cfg.monthlyBudgetUsd),
        limitUnit: 'USD',
        timeUnit: 'MONTHLY',
        notifications: [
          {
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
            notificationType: 'ACTUAL',
            subscriberEmailAddresses: [cfg.budgetAlertEmail],
          },
          {
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
            notificationType: 'FORECASTED',
            subscriberEmailAddresses: [cfg.budgetAlertEmail],
          },
        ],
      },
      mgmtOpts,
    );
  }

  return {
    trailArn: trail.arn,
    trailBucketName: trailBucket.id,
  };
}
