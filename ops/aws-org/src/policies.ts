/** Service Control Policy documents (JSON). Exported for unit asserts. */

export const denyLeaveOrganizationPolicy = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'DenyLeaveOrganization',
      Effect: 'Deny',
      Action: ['organizations:LeaveOrganization', 'account:CloseAccount'],
      Resource: '*',
    },
  ],
} as const;

/**
 * Broader prod guardrail: block high-impact deletes and stack teardown.
 * Does not replace least-privilege IAM; Administrators can still do much harm.
 */
export const denyProdDestructivePolicy = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'DenyProdDestructiveDeletes',
      Effect: 'Deny',
      Action: [
        'rds:DeleteDBInstance',
        'rds:DeleteDBCluster',
        'rds:DeleteDBSnapshot',
        'rds:DeleteDBClusterSnapshot',
        's3:DeleteBucket',
        'dynamodb:DeleteTable',
        'lambda:DeleteFunction',
        'cloudformation:DeleteStack',
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:DeleteLoadBalancerListeners',
        'es:DeleteElasticsearchDomain',
        'es:DeleteDomain',
        'opensearch:DeleteDomain',
        'ecr:DeleteRepository',
        'kms:ScheduleKeyDeletion',
        'kms:DisableKey',
      ],
      Resource: '*',
    },
  ],
} as const;

/** Protect audit/security accounts from casual data-plane destruction. */
export const denySecurityDestructivePolicy = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'DenySecurityAuditDestruction',
      Effect: 'Deny',
      Action: [
        's3:DeleteBucket',
        's3:DeleteObject',
        's3:DeleteObjectVersion',
        's3:PutBucketPolicy',
        's3:DeleteBucketPolicy',
        's3:PutEncryptionConfiguration',
        'cloudtrail:DeleteTrail',
        'cloudtrail:StopLogging',
        'cloudtrail:UpdateTrail',
        'guardduty:DeleteDetector',
        'guardduty:DisableOrganizationAdminAccount',
        'securityhub:DisableSecurityHub',
        'kms:ScheduleKeyDeletion',
        'kms:DisableKey',
      ],
      Resource: '*',
      // Allow management→member bootstrap via Organizations access role.
      Condition: {
        ArnNotLike: {
          'aws:PrincipalArn': ['arn:aws:iam::*:role/OrganizationAccountAccessRole'],
        },
      },
    },
  ],
} as const;

/**
 * NonProd cost / blast-radius guardrail: block common high-spend network and
 * data-plane services that staging rarely needs.
 */
export const denyNonProdExpensivePolicy = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'DenyNonProdExpensiveCreates',
      Effect: 'Deny',
      Action: [
        'ec2:CreateNatGateway',
        'ec2:CreateTransitGateway',
        'ec2:CreateVpnConnection',
        'ec2:CreateVpnGateway',
        'ec2:CreateVpcPeeringConnection',
        'ec2:AllocateAddress',
        'ec2:PurchaseReservedInstancesOffering',
        'ec2:PurchaseHostReservation',
        'ec2:CreateCapacityReservation',
        'directconnect:*',
        'redshift:CreateCluster',
        'redshift:CreateClusterSnapshot',
        'sagemaker:CreateNotebookInstance',
        'sagemaker:CreateTrainingJob',
        'sagemaker:CreateEndpoint',
        'eks:CreateCluster',
        'elasticache:CreateCacheCluster',
        'elasticache:CreateReplicationGroup',
        'es:CreateElasticsearchDomain',
        'es:CreateDomain',
        'opensearch:CreateDomain',
        'kafka:CreateCluster',
        'kafka:CreateClusterV2',
        'savingsplans:CreateSavingsPlan',
      ],
      Resource: '*',
    },
  ],
} as const;

/**
 * Region lock with global-service exemptions aligned to Control Tower's
 * primary region deny pattern (subset kept for maintainability).
 */
export function denyNonHomeRegionsPolicy(homeRegion: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyNonHomeRegions',
        Effect: 'Deny',
        NotAction: [
          'a4b:*',
          'account:*',
          'acm:*',
          'aws-marketplace-management:*',
          'aws-marketplace:*',
          'aws-portal:*',
          'billing:*',
          'billingconductor:*',
          'budgets:*',
          'ce:*',
          'chatbot:*',
          'chime:*',
          'cloudfront:*',
          'cloudtrail:LookupObject*',
          'cloudtrail:Get*',
          'cloudtrail:List*',
          'cloudtrail:LookupEvents',
          'config:*',
          'cur:*',
          'directconnect:*',
          'ec2:DescribeRegions',
          'ec2:DescribeTransitGateways',
          'ec2:DescribeVpnGateways',
          'fms:*',
          'globalaccelerator:*',
          'health:*',
          'iam:*',
          'importexport:*',
          'kms:*',
          'mobileanalytics:*',
          'networkmanager:*',
          'organizations:*',
          'pricing:*',
          'resource-explorer-2:*',
          'route53-recovery-cluster:*',
          'route53-recovery-control-config:*',
          'route53-recovery-readiness:*',
          'route53:*',
          'route53domains:*',
          's3:CreateMultiRegionAccessPoint',
          's3:DeleteMultiRegionAccessPoint',
          's3:DescribeMultiRegionAccessPointOperation',
          's3:GetAccountPublic*',
          's3:GetBucketLocation',
          's3:GetBucketPolicyStatus',
          's3:GetBucketPublicAccessBlock',
          's3:GetMultiRegionAccessPoint',
          's3:GetMultiRegionAccessPointPolicy',
          's3:GetMultiRegionAccessPointPolicyStatus',
          's3:GetStorageLensConfiguration',
          's3:GetStorageLensDashboard',
          's3:ListAllMyBuckets',
          's3:ListMultiRegionAccessPoints',
          's3:ListStorageLensConfigurations',
          's3:PutAccountPublic*',
          's3:PutMultiRegionAccessPointPolicy',
          'savingsplans:*',
          'shield:*',
          'sso:*',
          'sso-directory:*',
          'sts:*',
          'support:*',
          'supportapp:*',
          'supportplans:*',
          'sustainability:*',
          'tag:GetResources',
          'tax:*',
          'trustedadvisor:*',
          'vendor-insights:ListEntitledSecurityProfiles',
          'waf-regional:*',
          'waf:*',
          'wafv2:*',
          'wellarchitected:*',
        ],
        Resource: '*',
        Condition: {
          StringNotEquals: {
            'aws:RequestedRegion': [homeRegion, 'us-east-1'],
          },
        },
      },
    ],
  } as const;
}

export function policyDocumentJson(doc: object): string {
  return JSON.stringify(doc);
}
