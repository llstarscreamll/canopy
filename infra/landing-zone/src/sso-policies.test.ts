import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { policyDocumentJson } from './policies';
import { productMcpDenyPolicy } from './sso-policies';

describe('ProductMCP SSO inline deny', () => {
  it('denies SSM parameter and Secrets Manager reads', () => {
    const actions = productMcpDenyPolicy.Statement[0].Action;
    assert.ok(actions.includes('ssm:GetParameter'));
    assert.ok(actions.includes('ssm:GetParametersByPath'));
    assert.ok(actions.includes('secretsmanager:GetSecretValue'));
    assert.ok(actions.includes('lambda:GetFunctionConfiguration'));
    assert.doesNotThrow(() => JSON.parse(policyDocumentJson(productMcpDenyPolicy)));
  });

  it('denies destructive and IAM/org mutations', () => {
    const actions = productMcpDenyPolicy.Statement[1].Action;
    assert.ok(actions.includes('s3:DeleteBucket'));
    assert.ok(actions.includes('cloudformation:DeleteStack'));
    assert.ok(actions.includes('iam:*'));
    assert.ok(actions.includes('organizations:*'));
    assert.ok(actions.includes('lambda:UpdateFunctionCode'));
  });
});
