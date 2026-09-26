import { expect } from '@playwright/test';
import { test } from '../../support/api.fixture';
import { expectStatus, readJson } from '../../support/http-assertions';

const OPERATION = 'GET /api/health';

test.describe(OPERATION, () => {
  test('responde ok', async ({ platformApi }) => {
    // given

    // when
    const response = await platformApi.call('/api/health');

    // then
    await expectStatus(response, 200, OPERATION);
    const payload = await readJson<{
      status: string;
      version: string;
      build: number;
      revision: string;
      released_at: string;
      environment: string;
      support_email?: string;
      license_label?: string;
    }>(response, OPERATION);
    expect(payload.status, `${OPERATION}: status`).toBe('ok');
    expect(payload.version, `${OPERATION}: version`).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
    expect(payload.build, `${OPERATION}: build`).toBeGreaterThan(0);
    expect(payload.revision, `${OPERATION}: revision`).toMatch(/^[0-9a-f]{4,40}$|unknown/);
    expect(payload.released_at, `${OPERATION}: released_at`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(payload.environment, `${OPERATION}: environment`).toMatch(/^(local|staging|production)$/);
    expect(payload.support_email, `${OPERATION}: support_email`).toBe('soporte@atta.com');
    expect(payload.license_label, `${OPERATION}: license_label`).toBeTruthy();
  });
});
