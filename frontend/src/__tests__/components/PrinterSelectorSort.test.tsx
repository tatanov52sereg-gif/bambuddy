/**
 * The PrintModal's printer list is fed straight from `GET /printers/`, which
 * the API orders by `name` in the database — a character-by-character compare
 * that puts "A-1-10" between "A-1-1" and "A-1-2". The selector re-sorts the
 * rows numerically so a farm numbered A-1-1 … A-1-10 reads in that order.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { PrinterSelector } from '../../components/PrintModal/PrinterSelector';
import type { Printer } from '../../api/client';

function makePrinter(id: number, name: string): Printer {
  return {
    id,
    name,
    model: 'A1',
    ip_address: `192.168.0.${id}`,
    enabled: true,
    is_active: true,
  } as Printer;
}

// Deliberately in the API's lexicographic order: ...-1, ...-10, ...-2 ...
const printers: Printer[] = [
  makePrinter(1, 'A-1-1'),
  makePrinter(10, 'A-1-10'),
  makePrinter(2, 'A-1-2'),
  makePrinter(3, 'A-1-3'),
];

describe('PrinterSelector ordering', () => {
  it('sorts the printer list numerically by name', async () => {
    render(
      <PrinterSelector
        printers={printers}
        selectedPrinterIds={[]}
        onMultiSelect={() => undefined}
        allowMultiple
      />,
    );

    const names = await screen.findAllByText(/^A-1-\d+$/);

    expect(names.map((node) => node.textContent)).toEqual([
      'A-1-1',
      'A-1-2',
      'A-1-3',
      'A-1-10',
    ]);
  });
});
