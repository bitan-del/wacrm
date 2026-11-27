'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';

/**
 * Whether the workspace can send SMS (configured + switched on). Read
 * by the inbox composer and the broadcast wizard. `GET /api/sms/config`
 * answers any member with just this — the config row itself is
 * admin-only. Cached per account for 30 s so every open thread doesn't
 * refetch; Settings → SMS invalidates on save.
 */
export interface SmsStatus {
  loading: boolean;
  enabled: boolean;
  /** Brand the broadcast composer prefixes; null when not set. */
  brandName: string | null;
}

interface SmsStatusData {
  enabled: boolean;
  brandName: string | null;
}

const NOT_ENABLED: SmsStatusData = { enabled: false, brandName: null };

const TTL_MS = 30_000;
const cache = new Map<string, { data: SmsStatusData; expiresAt: number; pending?: Promise<SmsStatusData> }>();

export function invalidateSmsStatus(): void {
  cache.clear();
}

function fetchSmsStatus(accountId: string): Promise<SmsStatusData> {
  const hit = cache.get(accountId);
  if (hit?.pending) return hit.pending;
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.data);

  const pending = fetch('/api/sms/config', { cache: 'no-store' })
    .then(async (res): Promise<SmsStatusData> => {
      if (!res.ok) return NOT_ENABLED;
      const data = await res.json();
      return {
        enabled: Boolean(data?.configured && data?.is_active),
        brandName: typeof data?.brand_name === 'string' && data.brand_name ? data.brand_name : null,
      };
    })
    .catch(() => NOT_ENABLED)
    .then((data) => {
      cache.set(accountId, { data, expiresAt: Date.now() + TTL_MS });
      return data;
    });
  cache.set(accountId, { data: hit?.data ?? NOT_ENABLED, expiresAt: 0, pending });
  return pending;
}

export function useSmsStatus(): SmsStatus {
  const { accountId } = useAuth();
  const [state, setState] = useState<{ accountId: string | null; data: SmsStatusData }>({
    accountId: null,
    data: NOT_ENABLED,
  });

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void fetchSmsStatus(accountId).then((data) => {
      if (!cancelled) setState({ accountId, data });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const current = state.accountId === accountId ? state.data : NOT_ENABLED;
  return {
    loading: !accountId || state.accountId !== accountId,
    enabled: current.enabled,
    brandName: current.brandName,
  };
}
