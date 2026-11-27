import { describe, expect, it } from 'vitest';

import { classifySmsKeyword, intentFromProviderHint, normalizeKeywordText } from './keywords';

describe('classifySmsKeyword — opt-out', () => {
  it.each(['STOP', 'stop', ' Stop ', 'STOP.', 'stop!!', 'STOPALL', 'Unsubscribe', 'CANCEL', 'end', 'Quit', 'REVOKE', 'optout', 'opt out', 'Opt-Out', 'OPT_OUT'])(
    'treats %j as an opt-out',
    (body) => {
      expect(classifySmsKeyword(body)).toBe('opt_out');
    },
  );

  it('matches full-width and emoji-decorated keywords', () => {
    expect(classifySmsKeyword('ＳＴＯＰ')).toBe('opt_out');
    expect(classifySmsKeyword('🛑 STOP 🛑')).toBe('opt_out');
  });

  it('treats a short message containing an unambiguous opt-out word as an opt-out', () => {
    expect(classifySmsKeyword('Stop please')).toBe('opt_out');
    expect(classifySmsKeyword('Please stop')).toBe('opt_out');
    expect(classifySmsKeyword('stop texting me')).toBe('opt_out');
    expect(classifySmsKeyword('STOP STOP STOP')).toBe('opt_out');
    expect(classifySmsKeyword('unsubscribe me now')).toBe('opt_out');
    expect(classifySmsKeyword('opt out pls')).toBe('opt_out');
  });

  it('does not treat customer-service requests as opt-outs', () => {
    expect(classifySmsKeyword('Cancel my order')).toBeNull();
    expect(classifySmsKeyword('End of the month works')).toBeNull();
    expect(classifySmsKeyword('Can you stop by tomorrow at 5?')).toBeNull();
    expect(classifySmsKeyword('please end it')).toBeNull();
  });
});

describe('classifySmsKeyword — opt-in and help', () => {
  it.each(['START', 'start', 'Unstop', 'UNSTOP!'])('treats %j as an opt-in', (body) => {
    expect(classifySmsKeyword(body)).toBe('opt_in');
  });

  it.each(['HELP', 'help?', 'Info'])('treats %j as help', (body) => {
    expect(classifySmsKeyword(body)).toBe('help');
  });

  it('does not treat a YES reply as an opt-in', () => {
    expect(classifySmsKeyword('Yes')).toBeNull();
  });

  it('ignores ordinary messages and empty bodies', () => {
    expect(classifySmsKeyword('Hi, is the store open today?')).toBeNull();
    expect(classifySmsKeyword('')).toBeNull();
    expect(classifySmsKeyword('   ')).toBeNull();
    expect(classifySmsKeyword('Start time?')).toBeNull();
  });
});

describe('provider keyword hint', () => {
  it('maps Twilio OptOutType values', () => {
    expect(intentFromProviderHint('STOP')).toBe('opt_out');
    expect(intentFromProviderHint('start')).toBe('opt_in');
    expect(intentFromProviderHint('HELP')).toBe('help');
    expect(intentFromProviderHint('')).toBeNull();
    expect(intentFromProviderHint(undefined)).toBeNull();
  });

  it('wins over our own matching (custom keywords configured in Twilio)', () => {
    expect(classifySmsKeyword('ARRET', 'STOP')).toBe('opt_out');
    expect(classifySmsKeyword('STOP', 'START')).toBe('opt_in');
  });
});

describe('normalizeKeywordText', () => {
  it('upper-cases, strips punctuation and collapses whitespace', () => {
    expect(normalizeKeywordText('  opt-out!!  now ')).toBe('OPT OUT NOW');
  });
});
