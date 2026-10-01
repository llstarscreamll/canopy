#!/usr/bin/env node
/**
 * Detach legacy DenyLeave* SCPs from the Organizations root so Transition OU
 * is not blocked from LeaveOrganization. Idempotent. Honors DETACH_ROOT_LEAVE_SCP.
 */
import { spawnSync } from 'node:child_process';

function awsJson(args) {
  const r = spawnSync('aws', [...args, '--output', 'json'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || `aws ${args.join(' ')} failed`);
  }
  return JSON.parse(r.stdout || 'null');
}

function awsOk(args) {
  const r = spawnSync('aws', args, { encoding: 'utf8', env: process.env });
  return r.status === 0;
}

const enabled = (process.env.DETACH_ROOT_LEAVE_SCP || 'true').toLowerCase();
if (enabled === 'false' || enabled === '0' || enabled === 'no') {
  console.log('detach-root-leave-scp: skipped (DETACH_ROOT_LEAVE_SCP=false)');
  process.exit(0);
}

const roots = awsJson(['organizations', 'list-roots']);
const rootId = roots?.Roots?.[0]?.Id;
if (!rootId) {
  throw new Error('detach-root-leave-scp: no Organizations root found');
}

const policies = awsJson([
  'organizations',
  'list-policies-for-target',
  '--target-id',
  rootId,
  '--filter',
  'SERVICE_CONTROL_POLICY',
]);

const leavePolicies = (policies?.Policies || []).filter((p) =>
  String(p.Name || '').includes('Leave'),
);

if (leavePolicies.length === 0) {
  console.log('detach-root-leave-scp: no root Leave* SCPs attached');
  process.exit(0);
}

for (const p of leavePolicies) {
  const ok = awsOk([
    'organizations',
    'detach-policy',
    '--policy-id',
    p.Id,
    '--target-id',
    rootId,
  ]);
  console.log(
    ok
      ? `detach-root-leave-scp: detached ${p.Name} (${p.Id}) from ${rootId}`
      : `detach-root-leave-scp: detach ${p.Name} (${p.Id}) failed or already detached`,
  );
}
