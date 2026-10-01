import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { denyLeaveOrganizationPolicy, denyNonHomeRegionsPolicy, denyNonProdExpensivePolicy, denyProdDestructivePolicy, denySecurityDestructivePolicy, policyDocumentJson } from './policies';

describe('SCP policy documents', () => {
  it('denyLeaveOrganization denies leave and account close', () => {
    const doc = denyLeaveOrganizationPolicy;
    assert.equal(doc.Version, '2012-10-17');
    assert.equal(doc.Statement[0].Effect, 'Deny');
    assert.deepEqual(doc.Statement[0].Action, ['organizations:LeaveOrganization', 'account:CloseAccount']);
    assert.doesNotThrow(() => JSON.parse(policyDocumentJson(doc)));
  });

  it('denyProdDestructive blocks high-impact deletes', () => {
    const actions = denyProdDestructivePolicy.Statement[0].Action;
    assert.ok(actions.includes('rds:DeleteDBInstance'));
    assert.ok(actions.includes('s3:DeleteBucket'));
    assert.ok(actions.includes('cloudformation:DeleteStack'));
    assert.ok(actions.includes('lambda:DeleteFunction'));
    assert.ok(actions.includes('kms:ScheduleKeyDeletion'));
    assert.equal(denyProdDestructivePolicy.Statement[0].Effect, 'Deny');
  });

  it('denySecurityDestructive protects audit controls', () => {
    const stmt = denySecurityDestructivePolicy.Statement[0];
    const actions = stmt.Action;
    assert.ok(actions.includes('cloudtrail:StopLogging'));
    assert.ok(actions.includes('guardduty:DeleteDetector'));
    assert.ok(actions.includes('s3:DeleteObjectVersion'));
    assert.deepEqual(stmt.Condition?.ArnNotLike?.['aws:PrincipalArn'], ['arn:aws:iam::*:role/OrganizationAccountAccessRole']);
  });

  it('denyNonProdExpensive blocks high-spend creates', () => {
    const actions = denyNonProdExpensivePolicy.Statement[0].Action;
    assert.ok(actions.includes('ec2:CreateNatGateway'));
    assert.ok(actions.includes('eks:CreateCluster'));
    assert.ok(actions.includes('savingsplans:CreateSavingsPlan'));
  });

  it('denyNonHomeRegions keeps home region and us-east-1 and exempts SSO/account', () => {
    const doc = denyNonHomeRegionsPolicy('eu-west-1');
    assert.deepEqual(doc.Statement[0].Condition.StringNotEquals['aws:RequestedRegion'], ['eu-west-1', 'us-east-1']);
    assert.equal(doc.Statement[0].Effect, 'Deny');
    assert.ok(doc.Statement[0].NotAction.includes('iam:*'));
    assert.ok(doc.Statement[0].NotAction.includes('organizations:*'));
    assert.ok(doc.Statement[0].NotAction.includes('sso:*'));
    assert.ok(doc.Statement[0].NotAction.includes('account:*'));
    assert.ok(doc.Statement[0].NotAction.includes('billing:*'));
  });
});
