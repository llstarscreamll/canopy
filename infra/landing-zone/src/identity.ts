import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { isProdEnvironment, memberAccountAlias, type LandingZoneConfig, type SsoAssignmentPrincipals, workloadAccountSlug } from './config';

/** IAM account aliases `{org}-{slug}` on each member account. */
export function wireAccountAliases(cfg: LandingZoneConfig, nameSuffix: string, accountMap: Record<string, pulumi.Output<string>>): void {
  if (!cfg.accountAliases) {
    return;
  }
  const n = (base: string) => `${base}${nameSuffix}`;
  for (const [slug, accountId] of Object.entries(accountMap)) {
    const provider = new aws.Provider(n(`provider-alias-${slug}`), {
      region: cfg.awsRegion as aws.Region,
      assumeRoles: [
        {
          roleArn: pulumi.interpolate`arn:aws:iam::${accountId}:role/OrganizationAccountAccessRole`,
          sessionName: `lz-alias-${slug}`.slice(0, 64),
        },
      ],
    });
    new aws.iam.AccountAlias(n(`alias-${slug}`), { accountAlias: memberAccountAlias(cfg, slug) }, { provider });
  }
}

type PermissionSetName = 'PlatformAdmin' | 'ProductDeveloper' | 'ProductReadonly' | 'ProductMCP';

function assignmentRows(
  principals: SsoAssignmentPrincipals,
  permissionSets: Record<PermissionSetName, aws.ssoadmin.PermissionSet>,
  accounts: {
    managementAccountId: pulumi.Input<string>;
    stagingAccountIds: pulumi.Input<string>[];
    prodAccountIds: pulumi.Input<string>[];
  },
): Array<{
  key: string;
  principalType: 'USER' | 'GROUP';
  principalId: string;
  permissionSet: aws.ssoadmin.PermissionSet;
  targetId: pulumi.Input<string>;
}> {
  const rows: Array<{
    key: string;
    principalType: 'USER' | 'GROUP';
    principalId: string;
    permissionSet: aws.ssoadmin.PermissionSet;
    targetId: pulumi.Input<string>;
  }> = [];

  const push = (keyPrefix: string, principalType: 'USER' | 'GROUP', ids: string[], permissionSet: aws.ssoadmin.PermissionSet, targetIds: pulumi.Input<string>[]) => {
    for (const principalId of ids) {
      targetIds.forEach((targetId, idx) => {
        rows.push({
          key: `${keyPrefix}-${principalType.toLowerCase()}-${principalId.slice(0, 8)}-${idx}`,
          principalType,
          principalId,
          permissionSet,
          targetId,
        });
      });
    }
  };

  push('platform-admin', 'USER', principals.platformAdminUsers, permissionSets.PlatformAdmin, [accounts.managementAccountId]);
  push('platform-admin', 'GROUP', principals.platformAdminGroups, permissionSets.PlatformAdmin, [accounts.managementAccountId]);
  push('staging-developer', 'USER', principals.stagingDeveloperUsers, permissionSets.ProductDeveloper, accounts.stagingAccountIds);
  push('staging-developer', 'GROUP', principals.stagingDeveloperGroups, permissionSets.ProductDeveloper, accounts.stagingAccountIds);
  push('staging-mcp', 'USER', principals.stagingMcpUsers, permissionSets.ProductMCP, accounts.stagingAccountIds);
  push('staging-mcp', 'GROUP', principals.stagingMcpGroups, permissionSets.ProductMCP, accounts.stagingAccountIds);
  push('prod-readonly', 'USER', principals.prodReadonlyUsers, permissionSets.ProductReadonly, accounts.prodAccountIds);
  push('prod-readonly', 'GROUP', principals.prodReadonlyGroups, permissionSets.ProductReadonly, accounts.prodAccountIds);

  return rows;
}

export function wireSsoAssignments(
  cfg: LandingZoneConfig,
  nameSuffix: string,
  opts: {
    instanceArn: pulumi.Input<string>;
    permissionSets: Record<PermissionSetName, aws.ssoadmin.PermissionSet>;
    managementAccountId: pulumi.Input<string>;
    accountMap: Record<string, pulumi.Output<string>>;
    providerOpts: pulumi.ResourceOptions;
  },
): void {
  const n = (base: string) => `${base}${nameSuffix}`;
  const stagingAccountIds: pulumi.Input<string>[] = [];
  const prodAccountIds: pulumi.Input<string>[] = [];
  for (const product of cfg.products) {
    for (const env of cfg.environments) {
      const slug = workloadAccountSlug(product, env);
      const id = opts.accountMap[slug];
      if (!id) {
        continue;
      }
      if (isProdEnvironment(env)) {
        prodAccountIds.push(id);
      } else {
        stagingAccountIds.push(id);
      }
    }
  }

  const rows = assignmentRows(cfg.ssoAssignments, opts.permissionSets, {
    managementAccountId: opts.managementAccountId,
    stagingAccountIds,
    prodAccountIds,
  });

  for (const row of rows) {
    new aws.ssoadmin.AccountAssignment(
      n(`sso-assign-${row.key}`),
      {
        instanceArn: opts.instanceArn,
        permissionSetArn: row.permissionSet.arn,
        principalId: row.principalId,
        principalType: row.principalType,
        targetId: row.targetId,
        targetType: 'AWS_ACCOUNT',
      },
      opts.providerOpts,
    );
  }
}
