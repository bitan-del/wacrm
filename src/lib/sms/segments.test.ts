import { describe, expect, it } from 'vitest';

import { countSmsSegments, estimateSmsCost, isGsm7 } from './segments';

describe('countSmsSegments — GSM-7', () => {
  it('counts an empty message as zero segments', () => {
    const info = countSmsSegments('');
    expect(info.segments).toBe(0);
    expect(info.encoding).toBe('GSM-7');
  });

  it('fits 160 plain characters in one segment', () => {
    const info = countSmsSegments('a'.repeat(160));
    expect(info).toMatchObject({ encoding: 'GSM-7', segments: 1, units: 160, remainingInSegment: 0 });
  });

  it('splits at 161 into 153-character parts', () => {
    expect(countSmsSegments('a'.repeat(161)).segments).toBe(2);
    expect(countSmsSegments('a'.repeat(306)).segments).toBe(2);
    expect(countSmsSegments('a'.repeat(307)).segments).toBe(3);
  });

  it('charges two septets for extension-table characters', () => {
    const info = countSmsSegments('€'.repeat(80));
    expect(info.encoding).toBe('GSM-7');
    expect(info.units).toBe(160);
    expect(info.segments).toBe(1);
    expect(countSmsSegments('€'.repeat(81)).segments).toBe(2);
  });

  it('never splits an escape pair across a segment boundary', () => {
    // 152 plain + one € (2 septets) = 154 > 153 → the € starts part 2.
    const text = 'a'.repeat(152) + '€' + 'a'.repeat(10);
    const info = countSmsSegments(text);
    expect(info.units).toBe(164);
    expect(info.segments).toBe(2);
    expect(info.remainingInSegment).toBe(153 - 12);
  });

  it('treats accented Latin letters in the GSM table as GSM-7', () => {
    expect(isGsm7('Ça va? Ñandú, Ünïcode? no: Üü ÄÖ éèà')).toBe(false); // ï is not GSM
    expect(isGsm7('Ça va? Ñandú ÄÖÜ äöü éèùìò à')).toBe(false); // ú is not GSM
    expect(isGsm7('Ça va? Ñ ÄÖÜ äöü éèùìò à ß Ø å')).toBe(true);
  });
});

describe('countSmsSegments — UCS-2', () => {
  it('switches the whole message to UCS-2 on one non-GSM character', () => {
    const info = countSmsSegments('Hello ’world’');
    expect(info.encoding).toBe('UCS-2');
    expect(info.nonGsmCharacters).toEqual(['’']);
    expect(info.perSegment).toBe(70);
  });

  it('uses 70 / 67 limits', () => {
    expect(countSmsSegments('é'.repeat(69) + '’').segments).toBe(1);
    expect(countSmsSegments('’'.repeat(71)).segments).toBe(2);
    expect(countSmsSegments('’'.repeat(134)).segments).toBe(2);
    expect(countSmsSegments('’'.repeat(135)).segments).toBe(3);
  });

  it('counts an emoji as two code units and never splits it', () => {
    expect(countSmsSegments('😀'.repeat(35)).units).toBe(70);
    expect(countSmsSegments('😀'.repeat(35)).segments).toBe(1);
    // 66 units + emoji (2) would cross 67 → emoji starts part 2.
    const info = countSmsSegments('’'.repeat(66) + '😀' + '’'.repeat(10));
    expect(info.units).toBe(78);
    expect(info.segments).toBe(2);
  });
});

describe('estimateSmsCost', () => {
  it('multiplies segments by the per-segment price', () => {
    expect(estimateSmsCost(1000, 0.0083)).toBe(8.3);
  });

  it('is zero for nothing to send or a free rate', () => {
    expect(estimateSmsCost(0, 0.0083)).toBe(0);
    expect(estimateSmsCost(10, 0)).toBe(0);
    expect(estimateSmsCost(Number.NaN, 0.01)).toBe(0);
  });

  it('rounds away float noise', () => {
    expect(estimateSmsCost(3, 0.1)).toBe(0.3);
  });
});
