import { loadConfig } from './src/config';
import { buildLandingZone } from './src/stack';

const cfg = loadConfig();
const outputs = buildLandingZone(cfg);

export const organizationName = cfg.organizationName;
export const organizationId = outputs.organizationId;
export const securityOuId = outputs.securityOuId;
export const infrastructureOuId = outputs.infrastructureOuId;
export const workloadsOuId = outputs.workloadsOuId;
export const nonProdOuId = outputs.nonProdOuId;
export const prodOuId = outputs.prodOuId;
export const transitionOuId = outputs.transitionOuId;
export const accountIds = outputs.accountIds;
export const networkHub = cfg.networkHub;
export const securityBaseline = cfg.securityBaseline;
export const orgTrailArn = outputs.orgTrailArn;
export const orgTrailBucketName = outputs.orgTrailBucketName;
