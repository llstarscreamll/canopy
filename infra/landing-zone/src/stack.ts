import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { accountEmail, type LandingZoneConfig, workloadAccountSlug } from './config';
import { wireAccountAliases, wireSsoAssignments } from './identity';
import { denyLeaveOrganizationPolicy, denyNonHomeRegionsPolicy, denyNonProdExpensivePolicy, denyProdDestructivePolicy, denySecurityDestructivePolicy, policyDocumentJson } from './policies';
import { wireSecurityBaseline } from './security-baseline';
import { productMcpDenyPolicy } from './sso-policies';

export interface LandingZoneOutputs {
  organizationId: pulumi.Output<string>;
  securityOuId: pulumi.Output<string>;
  infrastructureOuId: pulumi.Output<string>;
  workloadsOuId: pulumi.Output<string>;
  nonProdOuId: pulumi.Output<string>;
  prodOuId: pulumi.Output<string>;
  transitionOuId: pulumi.Output<string>;
  accountIds: pulumi.Output<Record<string, string>>;
  orgTrailArn?: pulumi.Output<string>;
  orgTrailBucketName?: pulumi.Output<string>;
}

function tags(cfg: LandingZoneConfig, extra?: Record<string, string>) {
  return {
    ManagedBy: 'landing-zone',
    Organization: cfg.organizationName,
    ...extra,
  };
}

function createAccount(
  name: string,
  opts: {
    cfg: LandingZoneConfig;
    parentId: pulumi.Input<string>;
    slug: string;
    ou: string;
    provider: aws.Provider;
  },
): aws.organizations.Account {
  return new aws.organizations.Account(
    name,
    {
      name: opts.slug,
      email: accountEmail(opts.cfg, opts.slug),
      parentId: opts.parentId,
      roleName: 'OrganizationAccountAccessRole',
      closeOnDeletion: false,
      createGovcloud: false,
      tags: tags(opts.cfg, { AccountRole: opts.ou, AccountSlug: opts.slug }),
    },
    { provider: opts.provider, protect: true },
  );
}

/**
 * Builds the OU tree, foundation + workload accounts, SCPs, optional SSO
 * permission sets, security baseline, and cost budget for the management
 * account currently authenticated.
 *
 * @param nameSuffix - Unique suffix for Pulumi logical names (unit tests only).
 */
export function buildLandingZone(cfg: LandingZoneConfig, nameSuffix = ''): LandingZoneOutputs {
  const n = (base: string) => `${base}${nameSuffix}`;

  const awsProvider = new aws.Provider(n('aws'), {
    region: cfg.awsRegion as aws.Region,
    defaultTags: { tags: tags(cfg) },
  });
  const providerOpts: pulumi.ResourceOptions = { provider: awsProvider };
  const invokeOpts: pulumi.InvokeOutputOptions = { provider: awsProvider };

  const organization = aws.organizations.getOrganizationOutput({}, invokeOpts);
  const rootId = organization.roots.apply((roots) => {
    if (!roots?.length || !roots[0]?.id) {
      throw new Error('Organizations root not found on this management account');
    }
    return roots[0].id;
  });

  const securityOu = new aws.organizations.OrganizationalUnit(n('ou-security'), { name: 'Security', parentId: rootId, tags: tags(cfg, { Ou: 'Security' }) }, providerOpts);
  const infrastructureOu = new aws.organizations.OrganizationalUnit(
    n('ou-infrastructure'),
    {
      name: 'Infrastructure',
      parentId: rootId,
      tags: tags(cfg, { Ou: 'Infrastructure' }),
    },
    providerOpts,
  );
  const workloadsOu = new aws.organizations.OrganizationalUnit(
    n('ou-workloads'),
    {
      name: 'Workloads',
      parentId: rootId,
      tags: tags(cfg, { Ou: 'Workloads' }),
    },
    providerOpts,
  );
  const nonProdOu = new aws.organizations.OrganizationalUnit(
    n('ou-nonprod'),
    {
      name: 'NonProd',
      parentId: workloadsOu.id,
      tags: tags(cfg, { Ou: 'NonProd' }),
    },
    providerOpts,
  );
  const prodOu = new aws.organizations.OrganizationalUnit(
    n('ou-prod'),
    {
      name: 'Prod',
      parentId: workloadsOu.id,
      tags: tags(cfg, { Ou: 'Prod' }),
    },
    providerOpts,
  );
  // Break-glass: move an account here before approved LeaveOrganization.
  // Intentionally has no DenyLeave SCP attached.
  const transitionOu = new aws.organizations.OrganizationalUnit(
    n('ou-transition'),
    {
      name: 'Transition',
      parentId: rootId,
      tags: tags(cfg, { Ou: 'Transition' }),
    },
    providerOpts,
  );

  const logArchive = createAccount(n('acct-log-archive'), {
    cfg,
    parentId: securityOu.id,
    slug: 'log-archive',
    ou: 'Security',
    provider: awsProvider,
  });
  const securityTooling = createAccount(n('acct-security-tooling'), {
    cfg,
    parentId: securityOu.id,
    slug: 'security-tooling',
    ou: 'Security',
    provider: awsProvider,
  });
  const sharedServices = createAccount(n('acct-shared-services'), {
    cfg,
    parentId: infrastructureOu.id,
    slug: 'shared-services',
    ou: 'Infrastructure',
    provider: awsProvider,
  });

  const accountMap: Record<string, pulumi.Output<string>> = {
    'log-archive': logArchive.id,
    'security-tooling': securityTooling.id,
    'shared-services': sharedServices.id,
  };

  if (cfg.networkHub) {
    const network = createAccount(n('acct-network'), {
      cfg,
      parentId: infrastructureOu.id,
      slug: 'network',
      ou: 'Infrastructure',
      provider: awsProvider,
    });
    accountMap.network = network.id;
  }

  for (const product of cfg.products) {
    for (const env of cfg.environments) {
      const slug = workloadAccountSlug(product, env);
      const isProd = env === 'prod' || env === 'production';
      const acct = createAccount(n(`acct-${slug}`), {
        cfg,
        parentId: isProd ? prodOu.id : nonProdOu.id,
        slug,
        ou: isProd ? 'Prod' : 'NonProd',
        provider: awsProvider,
      });
      accountMap[slug] = acct.id;
    }
  }

  const denyLeave = new aws.organizations.Policy(
    n('scp-deny-leave-org'),
    {
      name: `${cfg.organizationName}-deny-leave-organization`,
      description: 'Prevent member accounts from leaving the organization or self-closing (not on Transition OU)',
      type: 'SERVICE_CONTROL_POLICY',
      content: policyDocumentJson(denyLeaveOrganizationPolicy),
      tags: tags(cfg, { Policy: 'DenyLeaveOrganization' }),
    },
    providerOpts,
  );
  for (const [attachName, targetId] of [
    [n('scp-deny-leave-workloads'), workloadsOu.id],
    [n('scp-deny-leave-security'), securityOu.id],
    [n('scp-deny-leave-infrastructure'), infrastructureOu.id],
  ] as const) {
    new aws.organizations.PolicyAttachment(attachName, { policyId: denyLeave.id, targetId }, providerOpts);
  }

  const denyProdDestructive = new aws.organizations.Policy(
    n('scp-deny-prod-destructive'),
    {
      name: `${cfg.organizationName}-deny-prod-destructive`,
      description: 'Block high-impact deletes in Production OU',
      type: 'SERVICE_CONTROL_POLICY',
      content: policyDocumentJson(denyProdDestructivePolicy),
      tags: tags(cfg, { Policy: 'DenyProdDestructive' }),
    },
    providerOpts,
  );
  new aws.organizations.PolicyAttachment(n('scp-deny-prod-destructive-attach'), { policyId: denyProdDestructive.id, targetId: prodOu.id }, providerOpts);

  const denySecurityDestructive = new aws.organizations.Policy(
    n('scp-deny-security-destructive'),
    {
      name: `${cfg.organizationName}-deny-security-destructive`,
      description: 'Protect CloudTrail/GuardDuty/S3 audit assets in Security OU',
      type: 'SERVICE_CONTROL_POLICY',
      content: policyDocumentJson(denySecurityDestructivePolicy),
      tags: tags(cfg, { Policy: 'DenySecurityDestructive' }),
    },
    providerOpts,
  );
  new aws.organizations.PolicyAttachment(n('scp-deny-security-destructive-attach'), { policyId: denySecurityDestructive.id, targetId: securityOu.id }, providerOpts);

  const denyNonProdExpensive = new aws.organizations.Policy(
    n('scp-deny-nonprod-expensive'),
    {
      name: `${cfg.organizationName}-deny-nonprod-expensive`,
      description: 'Block high-spend services in NonProd OU',
      type: 'SERVICE_CONTROL_POLICY',
      content: policyDocumentJson(denyNonProdExpensivePolicy),
      tags: tags(cfg, { Policy: 'DenyNonProdExpensive' }),
    },
    providerOpts,
  );
  new aws.organizations.PolicyAttachment(n('scp-deny-nonprod-expensive-attach'), { policyId: denyNonProdExpensive.id, targetId: nonProdOu.id }, providerOpts);

  const denyRegions = new aws.organizations.Policy(
    n('scp-deny-non-home-regions'),
    {
      name: `${cfg.organizationName}-deny-non-home-regions`,
      description: `Restrict regional APIs outside ${cfg.awsRegion}`,
      type: 'SERVICE_CONTROL_POLICY',
      content: policyDocumentJson(denyNonHomeRegionsPolicy(cfg.awsRegion)),
      tags: tags(cfg, { Policy: 'DenyNonHomeRegions' }),
    },
    providerOpts,
  );
  new aws.organizations.PolicyAttachment(n('scp-deny-regions-workloads'), { policyId: denyRegions.id, targetId: workloadsOu.id }, providerOpts);

  if (cfg.ssoPermissionSets) {
    const instances = aws.ssoadmin.getInstancesOutput({}, invokeOpts);
    const instanceArn = instances.arns.apply((arns) => {
      if (!arns?.length) {
        throw new Error('IAM Identity Center is not enabled on this management account (SSO_PERMISSION_SETS=true)');
      }
      return arns[0];
    });

    const sets: Array<{
      name: 'PlatformAdmin' | 'ProductDeveloper' | 'ProductReadonly' | 'ProductMCP';
      managedPolicyArn: string;
      sessionDuration: string;
      inlineDenyJson?: string;
    }> = [
      {
        name: 'PlatformAdmin',
        managedPolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess',
        sessionDuration: 'PT8H',
      },
      {
        name: 'ProductDeveloper',
        managedPolicyArn: 'arn:aws:iam::aws:policy/PowerUserAccess',
        sessionDuration: 'PT8H',
      },
      {
        name: 'ProductReadonly',
        managedPolicyArn: 'arn:aws:iam::aws:policy/ReadOnlyAccess',
        sessionDuration: 'PT8H',
      },
      {
        name: 'ProductMCP',
        managedPolicyArn: 'arn:aws:iam::aws:policy/ReadOnlyAccess',
        sessionDuration: 'PT4H',
        inlineDenyJson: policyDocumentJson(productMcpDenyPolicy),
      },
    ];

    const permissionSets = {} as Record<'PlatformAdmin' | 'ProductDeveloper' | 'ProductReadonly' | 'ProductMCP', aws.ssoadmin.PermissionSet>;

    for (const set of sets) {
      const permissionSet = new aws.ssoadmin.PermissionSet(
        n(`sso-ps-${set.name.toLowerCase()}`),
        {
          name: set.name,
          description: set.name === 'ProductMCP' ? 'Read-mostly for AI MCP debug; denies SSM/Secrets and destructive APIs' : undefined,
          instanceArn,
          sessionDuration: set.sessionDuration,
          tags: tags(cfg, { PermissionSet: set.name }),
        },
        providerOpts,
      );
      permissionSets[set.name] = permissionSet;
      new aws.ssoadmin.ManagedPolicyAttachment(
        n(`sso-ps-${set.name.toLowerCase()}-managed`),
        {
          instanceArn,
          permissionSetArn: permissionSet.arn,
          managedPolicyArn: set.managedPolicyArn,
        },
        providerOpts,
      );
      if (set.inlineDenyJson) {
        new aws.ssoadmin.PermissionSetInlinePolicy(
          n(`sso-ps-${set.name.toLowerCase()}-inline`),
          {
            instanceArn,
            permissionSetArn: permissionSet.arn,
            inlinePolicy: set.inlineDenyJson,
          },
          providerOpts,
        );
      }
    }

    wireSsoAssignments(cfg, nameSuffix, {
      instanceArn,
      permissionSets,
      managementAccountId: organization.masterAccountId,
      accountMap,
      providerOpts,
    });
  }

  wireAccountAliases(cfg, nameSuffix, accountMap);

  let orgTrailArn: pulumi.Output<string> | undefined;
  let orgTrailBucketName: pulumi.Output<string> | undefined;
  if (cfg.securityBaseline) {
    const baseline = wireSecurityBaseline({
      cfg,
      nameSuffix,
      managementProvider: awsProvider,
      organizationId: organization.id,
      managementAccountId: organization.masterAccountId,
      logArchiveAccountId: logArchive.id,
      securityToolingAccountId: securityTooling.id,
    });
    orgTrailArn = baseline.trailArn;
    orgTrailBucketName = baseline.trailBucketName;
  } else if (cfg.monthlyBudgetUsd != null && cfg.budgetAlertEmail) {
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
      providerOpts,
    );
  }

  const accountIds = pulumi.all(Object.entries(accountMap).map(([k, v]) => v.apply((id) => [k, id] as const))).apply((entries) => Object.fromEntries(entries));

  return {
    organizationId: organization.id,
    securityOuId: securityOu.id,
    infrastructureOuId: infrastructureOu.id,
    workloadsOuId: workloadsOu.id,
    nonProdOuId: nonProdOu.id,
    prodOuId: prodOu.id,
    transitionOuId: transitionOu.id,
    accountIds,
    orgTrailArn,
    orgTrailBucketName,
  };
}
