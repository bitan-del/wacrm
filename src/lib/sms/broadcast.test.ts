import { describe, expect, it } from 'vitest';

import { parseAudienceConfig, planSmsBroadcast } from './broadcast';

const config = {
  default_timezone: 'America/New_York',
  quiet_hours_start: 21,
  quiet_hours_end: 8,
  cost_per_segment: '0.0100',
};

describe('planSmsBroadcast', () => {
  // 13:00Z = 09:00 New York (EDT), 06:00 Los Angeles (PDT).
  const now = new Date('2026-07-15T13:00:00Z');

  it('renders each body, counts segments and prices them', () => {
    const plan = planSmsBroadcast(
      [
        { id: 'a', name: 'Ada', company: null as unknown as undefined, timezone: null },
        { id: 'b', name: 'Bo', company: undefined, timezone: null },
      ],
      'Hi {{first_name}}',
      config,
      now,
    );
    expect(plan.recipients.map((r) => r.body)).toEqual(['Hi Ada', 'Hi Bo']);
    expect(plan.totalSegments).toBe(2);
    expect(plan.estimatedCost).toBe(0.02);
    expect(plan.encoding).toBe('GSM-7');
    expect(plan.deferred).toBe(0);
    expect(plan.recipients.every((r) => r.scheduledFor === now.toISOString())).toBe(true);
  });

  it('defers recipients whose own timezone is in quiet hours', () => {
    const plan = planSmsBroadcast(
      [
        { id: 'ny', name: 'N', timezone: null },
        { id: 'la', name: 'L', timezone: 'America/Los_Angeles' },
      ],
      'Sale',
      config,
      now,
    );
    const la = plan.recipients.find((r) => r.contactId === 'la')!;
    expect(plan.deferred).toBe(1);
    expect(la.deferred).toBe(true);
    expect(la.scheduledFor).toBe('2026-07-15T15:00:00.000Z'); // 08:00 PDT
  });

  it('falls back to the account timezone for an invalid contact timezone', () => {
    const plan = planSmsBroadcast([{ id: 'x', name: 'X', timezone: 'Not/AZone' }], 'Sale', config, now);
    expect(plan.deferred).toBe(0);
  });

  it('reports UCS-2 when any recipient needs it', () => {
    const plan = planSmsBroadcast(
      [
        { id: 'a', name: 'Ann', timezone: null },
        { id: 'b', name: 'Zoë’s', timezone: null },
      ],
      'Hi {{first_name}}',
      config,
      now,
    );
    expect(plan.encoding).toBe('UCS-2');
  });
});

describe('parseAudienceConfig', () => {
  it('accepts the wizard shapes', () => {
    expect(parseAudienceConfig({ type: 'all' })).toMatchObject({ type: 'all' });
    expect(parseAudienceConfig({ type: 'tags', tagIds: ['t1', 2, 't2'] })).toMatchObject({
      type: 'tags',
      tagIds: ['t1', 't2'],
    });
    expect(
      parseAudienceConfig({ type: 'custom_field', customField: { fieldId: 'f', operator: 'weird', value: 'v' } }),
    ).toMatchObject({ customField: { fieldId: 'f', operator: 'is', value: 'v' } });
    expect(
      parseAudienceConfig({ type: 'csv', csvContacts: [{ phone: '+1415' }, { nope: 1 }, null] })?.csvContacts,
    ).toEqual([{ phone: '+1415' }]);
  });

  it('rejects unknown audience types', () => {
    expect(parseAudienceConfig({ type: 'everyone' })).toBeNull();
    expect(parseAudienceConfig(null)).toBeNull();
    expect(parseAudienceConfig('all')).toBeNull();
  });
});
