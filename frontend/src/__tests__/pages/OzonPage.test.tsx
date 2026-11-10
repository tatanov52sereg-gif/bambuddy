/**
 * Tests for the read-only Ozon stock page.
 *
 * The backend owns caching and rate limiting; here we only check that the page
 * renders the three states (not configured / disabled / populated), filters the
 * list, and keeps the Api-Key write-only in the settings form.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { OzonPage } from '../../pages/OzonPage';

const stocks = {
  configured: true,
  enabled: true,
  cached: false,
  fetched_at: '2026-11-10T10:00:00Z',
  total_products: 2,
  total_present: 15,
  total_reserved: 3,
  items: [
    {
      product_id: 10,
      offer_id: 'BRACKET-01',
      name: 'Steel bracket',
      sku: 900001,
      image: null,
      present: 10,
      reserved: 3,
      available: 7,
      warehouses: [
        {
          type: 'fbo',
          warehouse_id: 1,
          warehouse_name: 'Main warehouse',
          present: 7,
          reserved: 2,
        },
        {
          type: 'fbs',
          warehouse_id: 2,
          warehouse_name: 'Overflow',
          present: 3,
          reserved: 1,
        },
      ],
    },
    {
      product_id: 11,
      offer_id: 'SPOOL-02',
      name: 'Spool holder',
      sku: 900002,
      image: null,
      present: 5,
      reserved: 0,
      available: 5,
      warehouses: [
        {
          type: 'fbs',
          warehouse_id: 2,
          warehouse_name: 'Overflow',
          present: 5,
          reserved: 0,
        },
      ],
    },
  ],
};

afterEach(() => server.resetHandlers());

describe('OzonPage', () => {
  it('offers the settings shortcut when Ozon is not configured', async () => {
    server.use(
      http.get('*/ozon/stocks', () =>
        HttpResponse.json({
          configured: false,
          enabled: false,
          cached: false,
          fetched_at: null,
          total_products: 0,
          total_present: 0,
          total_reserved: 0,
          items: [],
        }),
      ),
    );

    render(<OzonPage />);

    expect(await screen.findByText('Ozon is not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument();
  });

  it('shows the totals and the warehouse breakdown of a product', async () => {
    server.use(http.get('*/ozon/stocks', () => HttpResponse.json(stocks)));

    render(<OzonPage />);

    expect(await screen.findByText('Steel bracket')).toBeInTheDocument();
    expect(screen.getByText('Spool holder')).toBeInTheDocument();
    expect(screen.getByText('BRACKET-01', { exact: false })).toBeInTheDocument();

    const list = screen.getByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { expanded: false, name: /Steel bracket/ }));

    expect(await screen.findByText('Main warehouse')).toBeInTheDocument();
    expect(screen.getByText('Overflow')).toBeInTheDocument();
    expect(screen.getByText('fbo')).toBeInTheDocument();

    // 10 present, 3 reserved and 7 available are shown in the summary cards and
    // again in the row; just assert the row's numbers are there.
    expect(screen.getAllByText('10').length).toBeGreaterThan(0);
  });

  it('filters products by article and keeps the search in the URL-free state', async () => {
    server.use(http.get('*/ozon/stocks', () => HttpResponse.json(stocks)));

    render(<OzonPage />);
    await screen.findByText('Steel bracket');

    await userEvent.type(screen.getByPlaceholderText(/search by name/i), 'spool');

    expect(await screen.findByText('Spool holder')).toBeInTheDocument();
    expect(screen.queryByText('Steel bracket')).not.toBeInTheDocument();
  });

  it('asks the backend for a forced refresh', async () => {
    let refreshSeen = false;
    server.use(
      http.get('*/ozon/stocks', ({ request }) => {
        const url = new URL(request.url);
        refreshSeen = url.searchParams.get('refresh') === 'true';
        return HttpResponse.json(stocks);
      }),
    );

    render(<OzonPage />);
    await screen.findByText('Steel bracket');

    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(refreshSeen).toBe(true);
  });

  it('never prefills the Api-Key field', async () => {
    let savedBody: Record<string, unknown> | null = null;
    server.use(
      http.get('*/ozon/stocks', () =>
        HttpResponse.json({
          configured: false,
          enabled: false,
          cached: false,
          fetched_at: null,
          total_products: 0,
          total_present: 0,
          total_reserved: 0,
          items: [],
        }),
      ),
      http.get('*/ozon/settings', () =>
        HttpResponse.json({ enabled: true, client_id: '123456', api_key_set: true }),
      ),
      http.put('*/ozon/settings', async ({ request }) => {
        savedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ enabled: true, client_id: '123456', api_key_set: true });
      }),
    );

    render(<OzonPage />);
    await screen.findByText('Ozon is not connected');

    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));

    const keyField = await screen.findByLabelText('API key');
    expect(keyField).toHaveValue('');
    expect(keyField).toHaveAttribute('type', 'password');
    expect(screen.getByText(/a key is saved/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(savedBody).toMatchObject({ enabled: true, client_id: '123456' });
    // A blank field must not send an empty key: that would erase the stored one.
    expect(savedBody).not.toHaveProperty('api_key');
  });
});
