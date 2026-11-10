/**
 * Tests for the read-only Ozon stock page.
 *
 * The backend owns caching and rate limiting; here we only check that the page
 * renders the three states (not configured / disabled / populated), filters the
 * list, and keeps the Api-Key write-only in the settings form.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
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

  it('shows the combined view by default and switches between All, FBO and FBS tabs', async () => {
    server.use(http.get('*/ozon/stocks', () => HttpResponse.json(stocks)));

    render(<OzonPage />);

    // Default "All" tab lists every product, regardless of scheme.
    expect(await screen.findByText('Steel bracket')).toBeInTheDocument();
    expect(screen.getByText('Spool holder')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');

    // FBO: only the product with FBO stock, and only its FBO warehouse.
    await userEvent.click(screen.getByRole('tab', { name: 'FBO' }));
    expect(await screen.findByText('Steel bracket')).toBeInTheDocument();
    expect(screen.queryByText('Spool holder')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'FBO' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('button', { expanded: false, name: /Steel bracket/ }));
    expect(await screen.findByText('Main warehouse')).toBeInTheDocument();
    // The seller's "Overflow" warehouse is FBS, so it must not leak into FBO.
    expect(screen.queryByText('Overflow')).not.toBeInTheDocument();

    // FBS: both products hold FBS stock, and "Main warehouse" is gone.
    await userEvent.click(screen.getByRole('tab', { name: 'FBS' }));
    expect(await screen.findByText('Spool holder')).toBeInTheDocument();
    expect(screen.getByText('Steel bracket')).toBeInTheDocument();
    expect(screen.queryByText('Main warehouse')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'FBS' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows an empty state for a scheme with no stock', async () => {
    server.use(
      http.get('*/ozon/stocks', () =>
        HttpResponse.json({
          ...stocks,
          items: [
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
                { type: 'fbs', warehouse_id: 2, warehouse_name: 'Overflow', present: 5, reserved: 0 },
              ],
            },
          ],
        }),
      ),
    );

    render(<OzonPage />);

    // The combined tab still lists the FBS-only product.
    expect(await screen.findByText('Spool holder')).toBeInTheDocument();

    // FBO is empty for this account.
    await userEvent.click(screen.getByRole('tab', { name: 'FBO' }));
    expect(await screen.findByText(/no fbo stock/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'FBS' }));
    expect(await screen.findByText('Spool holder')).toBeInTheDocument();
  });

  it('filters products by article within the active scheme', async () => {
    server.use(http.get('*/ozon/stocks', () => HttpResponse.json(stocks)));

    render(<OzonPage />);
    await screen.findByText('Steel bracket');

    await userEvent.click(screen.getByRole('tab', { name: 'FBO' }));
    await userEvent.type(screen.getByPlaceholderText(/search by name/i), 'spool');

    // "Spool holder" is FBS-only, so on the FBO tab nothing matches.
    expect(await screen.findByText(/no products match/i)).toBeInTheDocument();
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
