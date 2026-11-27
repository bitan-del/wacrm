import { describe, expect, it } from 'vitest';

import {
  composeSmsBroadcastBody,
  DEFAULT_OPT_OUT_SUFFIX,
  hasOptOutLanguage,
  renderSmsBody,
  unknownMergeTags,
} from './render';

describe('renderSmsBody', () => {
  const ada = { name: 'Ada Lovelace King', company: 'Analytical Co' };

  it('fills the supported merge tags', () => {
    expect(renderSmsBody('Hi {{first_name}} {{last_name}} of {{company}} ({{name}})', ada)).toBe(
      'Hi Ada Lovelace King of Analytical Co (Ada Lovelace King)',
    );
  });

  it('tolerates spacing and case inside the braces', () => {
    expect(renderSmsBody('Hi {{ First_Name }}!', ada)).toBe('Hi Ada!');
  });

  it('uses the fallback when the value is blank', () => {
    expect(renderSmsBody('Hi {{first_name|there}}, from {{company|us}}', { name: '', company: '' })).toBe(
      'Hi there, from us',
    );
  });

  it('renders a blank value as empty without a fallback', () => {
    expect(renderSmsBody('Hi {{first_name}}!', { name: undefined, company: undefined })).toBe('Hi !');
  });

  it('leaves unknown tags untouched so a typo is visible', () => {
    expect(renderSmsBody('Code {{coupon}}', ada)).toBe('Code {{coupon}}');
    expect(unknownMergeTags('Hi {{first_name}}, code {{coupon}} {{ZIP|x}}')).toEqual(['coupon', 'ZIP']);
  });
});

describe('composeSmsBroadcastBody', () => {
  it('prefixes the brand and appends opt-out language', () => {
    expect(
      composeSmsBroadcastBody('20% off today', { brandName: 'Acme', prefixBrand: true, appendOptOut: true }),
    ).toBe(`Acme: 20% off today\n${DEFAULT_OPT_OUT_SUFFIX}`);
  });

  it('does not double the brand or the opt-out line', () => {
    expect(
      composeSmsBroadcastBody('ACME deals! Reply STOP to end', {
        brandName: 'Acme',
        prefixBrand: true,
        appendOptOut: true,
      }),
    ).toBe('ACME deals! Reply STOP to end');
  });

  it('leaves the body alone when both options are off', () => {
    expect(composeSmsBroadcastBody('  hello  ', { brandName: 'Acme' })).toBe('hello');
  });

  it('skips the prefix when no brand is configured', () => {
    expect(composeSmsBroadcastBody('hello', { brandName: '  ', prefixBrand: true })).toBe('hello');
  });
});

describe('hasOptOutLanguage', () => {
  it('detects the usual phrasings', () => {
    expect(hasOptOutLanguage('Reply STOP to opt out')).toBe(true);
    expect(hasOptOutLanguage('Text unsubscribe anytime')).toBe(true);
    expect(hasOptOutLanguage('opt-out: reply END')).toBe(true);
    expect(hasOptOutLanguage('Big sale this weekend')).toBe(false);
    expect(hasOptOutLanguage('Nonstop savings')).toBe(false);
  });
});
