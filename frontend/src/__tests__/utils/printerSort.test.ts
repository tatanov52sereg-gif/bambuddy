/**
 * Tests for comparePrinterNames — the Printers page name sort.
 *
 * Printer names are numbered, and plain localeCompare is a character-by-char
 * comparison: "A-1-10" lands between "A-1-1" and "A-1-2". Operators expect
 * the tenth printer to sit at the end of the list (the reported symptom), so
 * the comparator compares runs of digits as numbers.
 */

import { describe, it, expect } from 'vitest';
import { comparePrinterNames } from '../../utils/printer';

const sortNames = (names: string[]) => [...names].sort(comparePrinterNames);

describe('comparePrinterNames', () => {
  it('places A-1-10 after A-1-9, not after A-1-1', () => {
    expect(
      sortNames(['A-1-10', 'A-1-2', 'A-1-1', 'A-1-9', 'A-1-3', 'A-1-4', 'A-1-5'])
    ).toEqual(['A-1-1', 'A-1-2', 'A-1-3', 'A-1-4', 'A-1-5', 'A-1-9', 'A-1-10']);
  });

  it('keeps zero-padded and bare numbers in the same order', () => {
    expect(sortNames(['A-1-09', 'A-1-10', 'A-1-2'])).toEqual([
      'A-1-2',
      'A-1-09',
      'A-1-10',
    ]);
  });

  it('handles multi-digit runs beyond two digits', () => {
    expect(sortNames(['A-2-100', 'A-2-99', 'A-2-9'])).toEqual([
      'A-2-9',
      'A-2-99',
      'A-2-100',
    ]);
  });

  it('leaves non-numbered names in alphabetical order', () => {
    expect(sortNames(['Workshop', 'Basement', 'Attic'])).toEqual([
      'Attic',
      'Basement',
      'Workshop',
    ]);
  });

  it('is a valid comparator (returns 0 for equal names)', () => {
    expect(comparePrinterNames('A-1-10', 'A-1-10')).toBe(0);
  });
});
