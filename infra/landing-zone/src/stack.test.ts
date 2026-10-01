import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import * as pulumi from '@pulumi/pulumi';
import type { LandingZoneConfig } from './config';

interface Registration {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

const registrations: Registration[] = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      registrations.push({
        type: args.type,
        name: args.name,
        inputs: { ...(args.inputs as Record<string, unknown>) },
      });
      return {
        id: `${args.name}_id`,
        state: {
          ...(args.inputs as Record<string, unknown>),
          arn: `arn:aws:mock:${args.type}:${args.name}`,
          id: `${args.name}_id`,
        },
      };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === 'aws:organizations/getOrganization:getOrganization') {
        return {
          id: 'o-mockorg',
          arn: 'arn:aws:organizations::111111111111:organization/o-mockorg',
          masterAccountId: '111111111111',
          roots: [
            {
              id: 'r-root',
              name: 'Root',
              arn: 'arn:aws:organizations::111111111111:root/o-mockorg/r-root',
            },
          ],
        };
      }
      if (args.token === 'aws:ssoadmin/getInstances:getInstances') {
        return {
          arns: ['arn:aws:sso:::instance/ssoins-mock'],
          ids: ['ssoins-mock'],
        };
      }
      return args.inputs;
    },
  },
  'landing-zone',
  'test',
);

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function baseConfig(overrides: Partial<LandingZoneConfig> = {}): LandingZoneConfig {
  return {
    organizationName: 'alar',
    awsRegion: 'us-east-1',
    networkHub: false,
    products: ['atta'],
    environments: ['staging', 'prod'],
    accountEmailLocal: 'aws',
    accountEmailDomain: 'example.com',
    ssoPermissionSets: true,
    securityBaseline: false,
    accountAliases: false,
    detachRootLeaveScp: false,
    ssoAssignments: {
      platformAdminUsers: [],
      platformAdminGroups: [],
      stagingDeveloperUsers: [],
      stagingDeveloperGroups: [],
      stagingMcpUsers: [],
      stagingMcpGroups: [],
      prodReadonlyUsers: [],
      prodReadonlyGroups: [],
    },
    repoRoot: '/tmp',
    ...overrides,
  };
}

describe('buildLandingZone (Pulumi mocks)', () => {
  let buildLandingZone: typeof import('./stack').buildLandingZone;

  before(async () => {
    ({ buildLandingZone } = await import('./stack'));
  });

  it('registers OUs, accounts, SCPs, Transition OU, and SSO sets', async () => {
    registrations.length = 0;
    buildLandingZone(baseConfig(), '-a');
    await settle();

    const types = (t: string) => registrations.filter((r) => r.type === t);
    const logicalOuNames = types('aws:organizations/organizationalUnit:OrganizationalUnit').map((r) => r.name);

    assert.deepEqual(logicalOuNames.sort(), ['ou-infrastructure-a', 'ou-nonprod-a', 'ou-prod-a', 'ou-security-a', 'ou-transition-a', 'ou-workloads-a']);

    const accounts = types('aws:organizations/account:Account');
    const accountNames = accounts.map((r) => r.inputs.name as string).sort();
    assert.deepEqual(accountNames, ['atta-prod', 'atta-staging', 'log-archive', 'security-tooling', 'shared-services']);
    assert.ok(!accountNames.includes('network'));

    assert.equal(types('aws:organizations/policy:Policy').length, 5);
    assert.ok(types('aws:organizations/policyAttachment:PolicyAttachment').length >= 5);

    // DenyLeave must not target Transition OU.
    const leaveAttaches = types('aws:organizations/policyAttachment:PolicyAttachment').filter((r) => String(r.name).includes('deny-leave'));
    assert.equal(leaveAttaches.length, 3);

    assert.equal(types('aws:ssoadmin/permissionSet:PermissionSet').length, 4);
    assert.equal(types('aws:ssoadmin/managedPolicyAttachment:ManagedPolicyAttachment').length, 4);
    assert.equal(types('aws:ssoadmin/permissionSetInlinePolicy:PermissionSetInlinePolicy').length, 1);
    const mcpInline = types('aws:ssoadmin/permissionSetInlinePolicy:PermissionSetInlinePolicy')[0];
    assert.ok(String(mcpInline.inputs.inlinePolicy).includes('ssm:GetParameter'));
    assert.ok(String(mcpInline.inputs.inlinePolicy).includes('DenySecretsAndCredentialReads'));
    assert.equal(types('aws:cloudtrail/trail:Trail').length, 0);
  });

  it('creates network account only when NETWORK_HUB is enabled', async () => {
    registrations.length = 0;
    buildLandingZone(baseConfig({ networkHub: true, ssoPermissionSets: false, securityBaseline: false }), '-b');
    await settle();

    const accountNames = registrations.filter((r) => r.type === 'aws:organizations/account:Account').map((r) => r.inputs.name as string);
    assert.ok(accountNames.includes('network'));
    assert.equal(registrations.filter((r) => r.type === 'aws:ssoadmin/permissionSet:PermissionSet').length, 0);
  });

  it('wires org CloudTrail and GuardDuty when SECURITY_BASELINE is enabled', async () => {
    registrations.length = 0;
    buildLandingZone(
      baseConfig({
        ssoPermissionSets: false,
        securityBaseline: true,
        monthlyBudgetUsd: 50,
        budgetAlertEmail: 'ops@alar.example',
      }),
      '-c',
    );
    await settle();

    assert.equal(registrations.filter((r) => r.type === 'aws:cloudtrail/trail:Trail').length, 1);
    assert.ok(registrations.some((r) => r.type === 'aws:s3/bucketV2:BucketV2'));
    assert.ok(registrations.some((r) => r.type === 'aws:guardduty/organizationAdminAccount:OrganizationAdminAccount'));
    assert.ok(registrations.some((r) => r.type === 'aws:guardduty/detector:Detector'));
    assert.ok(
      registrations.some((r) => r.type === 'aws:organizations/awsServiceAccess:AwsServiceAccess'),
      'expected Organizations AwsServiceAccess for GuardDuty/CloudTrail',
    );
    assert.ok(registrations.some((r) => r.type === 'aws:budgets/budget:Budget'));
  });

  it('creates SSO account assignments and aliases when configured', async () => {
    registrations.length = 0;
    const userId = '4478c4d8-4001-70fa-6c48-c3e7ff4d86d7';
    buildLandingZone(
      baseConfig({
        ssoPermissionSets: true,
        accountAliases: true,
        ssoAssignments: {
          platformAdminUsers: [userId],
          platformAdminGroups: [],
          stagingDeveloperUsers: [userId],
          stagingDeveloperGroups: [],
          stagingMcpUsers: [],
          stagingMcpGroups: [],
          prodReadonlyUsers: [userId],
          prodReadonlyGroups: [],
        },
      }),
      '-d',
    );
    await settle();

    const assignments = registrations.filter((r) => r.type === 'aws:ssoadmin/accountAssignment:AccountAssignment');
    // platform admin (mgmt) + staging developer + prod readonly = 3
    assert.equal(assignments.length, 3);
    assert.ok(registrations.some((r) => r.type === 'aws:iam/accountAlias:AccountAlias'));
  });
});
