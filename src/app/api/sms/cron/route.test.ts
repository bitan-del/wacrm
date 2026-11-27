import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/sms/broadcast', () => ({
  deliverDueSmsRecipients: vi.fn(async () => ({ claimed: 0, sent: 0, failed: 0, deferred: 0 })),
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET } from './route';

const ENV_KEYS = ['SMS_CRON_SECRET', 'AUTOMATION_CRON_SECRET', 'CRON_SECRET'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  __resetRateLimitForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const call = (headers: Record<string, string>) =>
  GET(new Request('https://crm.example.com/api/sms/cron', { headers }));

describe('GET /api/sms/cron auth', () => {
  it('runs with no configuration at all (nothing to set up per deploy)', async () => {
    expect((await call({})).status).toBe(200);
  });

  it('throttles an unconfigured endpoint so it cannot be hammered', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await call({})).status);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('accepts the pinger header secret', async () => {
    process.env.SMS_CRON_SECRET = 'pinger-secret';
    expect((await call({ 'x-cron-secret': 'pinger-secret' })).status).toBe(200);
    expect((await call({ 'x-cron-secret': 'wrong' })).status).toBe(401);
  });

  it("accepts Vercel Cron's bearer CRON_SECRET", async () => {
    process.env.CRON_SECRET = 'vercel-secret';
    expect((await call({ authorization: 'Bearer vercel-secret' })).status).toBe(200);
    expect((await call({ authorization: 'Bearer nope' })).status).toBe(401);
    expect((await call({})).status).toBe(401);
  });

  it('falls back to the automations secret for the header', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'auto-secret';
    expect((await call({ 'x-cron-secret': 'auto-secret' })).status).toBe(200);
  });
});
