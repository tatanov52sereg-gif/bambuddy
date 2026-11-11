import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Warehouse,
  X,
} from 'lucide-react';

import { ApiError, ozonApi } from '../api/client';
import type { OzonStockItem, OzonWarehouseStock } from '../api/client';
import { Button } from '../components/Button';
import { Card, CardContent } from '../components/Card';
import { Toggle } from '../components/Toggle';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

// Stable error codes from the backend -> i18n leaves. Anything unknown (a
// proxy error page, a timeout) falls through to the generic line: showing the
// raw English message in a translated UI is worse than a vague localised one.
const ERROR_KEYS: Record<string, string> = {
  ozon_invalid_credentials: 'ozonPage.errors.invalidCredentials',
  ozon_rate_limited: 'ozonPage.errors.rateLimited',
  ozon_unavailable: 'ozonPage.errors.unavailable',
  ozon_not_configured: 'ozonPage.errors.notConfigured',
  ozon_api_error: 'ozonPage.errors.generic',
};

function errorMessage(err: unknown, t: TFunction): string {
  if (err instanceof ApiError && err.code && ERROR_KEYS[err.code]) {
    return t(ERROR_KEYS[err.code]);
  }
  return t('ozonPage.errors.generic');
}

function itemKey(item: OzonStockItem): string {
  return item.product_id !== null ? String(item.product_id) : item.offer_id;
}

function number(value: number, locale: string): string {
  return value.toLocaleString(locale);
}

// Ozon splits stock by fulfilment scheme. A product can hold stock in both at
// once (some at Ozon's warehouse, some at the seller's), so the page shows
// "all", "fbo", "fbs" and "low" tabs and recomputes the totals from the rows.
type Scheme = 'fbo' | 'fbs';
type TabId = 'all' | Scheme | 'low';

const TABS: TabId[] = ['all', 'fbo', 'fbs', 'low'];

// Everything that is not Ozon's own storage ("fbo") is seller-side: an account
// using crossborder/realFBS still lands under the FBS tab instead of vanishing.
// The raw type stays visible in each product's warehouse breakdown.
function schemeOf(warehouse: OzonWarehouseStock): Scheme {
  return warehouse.type?.toLowerCase() === 'fbo' ? 'fbo' : 'fbs';
}

function tabLabel(tab: TabId, t: TFunction): string {
  if (tab === 'all') return t('ozonPage.tabAll');
  if (tab === 'low') return t('ozonPage.tabLow');
  return tab.toUpperCase();
}

interface SchemeRow {
  item: OzonStockItem;
  warehouses: OzonWarehouseStock[];
  present: number;
  reserved: number;
  available: number;
}

interface LowStockEntry {
  item: OzonStockItem;
  fbo: SchemeStock | null;
  fbs: SchemeStock | null;
}

interface SchemeStock {
  available: number;
  threshold: number;
  low: boolean;
}

function buildRows(items: OzonStockItem[], tab: TabId): SchemeRow[] {
  const rows: SchemeRow[] = [];
  for (const item of items) {
    const warehouses =
      tab === 'all'
        ? item.warehouses
        : item.warehouses.filter((warehouse) => schemeOf(warehouse) === tab);
    if (warehouses.length === 0) continue;
    const present = warehouses.reduce((sum, warehouse) => sum + warehouse.present, 0);
    const reserved = warehouses.reduce((sum, warehouse) => sum + warehouse.reserved, 0);
    rows.push({ item, warehouses, present, reserved, available: Math.max(present - reserved, 0) });
  }
  return rows;
}

function schemeStock(item: OzonStockItem, scheme: Scheme, threshold: number): SchemeStock | null {
  const warehouses = item.warehouses.filter((warehouse) => schemeOf(warehouse) === scheme);
  // A product that is not sold via this scheme at all (no warehouse rows) is
  // reported as null: zero stock here means "absent", not "running out".
  if (warehouses.length === 0) return null;
  const present = warehouses.reduce((sum, warehouse) => sum + warehouse.present, 0);
  const reserved = warehouses.reduce((sum, warehouse) => sum + warehouse.reserved, 0);
  const available = Math.max(present - reserved, 0);
  return { available, threshold, low: threshold > 0 && available < threshold };
}

function buildLowRows(
  items: OzonStockItem[],
  thresholds: { fbo: number; fbs: number },
): LowStockEntry[] {
  const entries: LowStockEntry[] = [];
  for (const item of items) {
    const fbo = schemeStock(item, 'fbo', thresholds.fbo);
    const fbs = schemeStock(item, 'fbs', thresholds.fbs);
    if (fbo?.low || fbs?.low) {
      entries.push({ item, fbo, fbs });
    }
  }
  return entries;
}

function entryMinAvailable(entry: LowStockEntry): number {
  const values: number[] = [];
  if (entry.fbo?.low) values.push(entry.fbo.available);
  if (entry.fbs?.low) values.push(entry.fbs.available);
  return values.length ? Math.min(...values) : Infinity;
}

export function OzonPage() {
  const { t, i18n } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [sortByStock, setSortByStock] = useState(false);
  const [tab, setTab] = useState<TabId>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const canManageSettings = hasPermission('settings:update');

  const stocksQuery = useQuery({
    queryKey: ['ozon-stocks'],
    queryFn: () => ozonApi.getStocks(false),
    // Ozon is rate-limited and the backend already caches for five minutes;
    // there is no point re-fetching every time the tab regains focus.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const refreshMutation = useMutation({
    mutationFn: () => ozonApi.getStocks(true),
    onSuccess: (data) => {
      queryClient.setQueryData(['ozon-stocks'], data);
    },
    onError: (err) => {
      showToast(errorMessage(err, t), 'error');
    },
  });

  const items = useMemo(() => stocksQuery.data?.items ?? [], [stocksQuery.data]);

  const thresholds = useMemo(
    () => ({
      fbo: stocksQuery.data?.low_stock_threshold_fbo ?? 0,
      fbs: stocksQuery.data?.low_stock_threshold_fbs ?? 0,
    }),
    [stocksQuery.data],
  );

  const rows = useMemo(
    () => (tab === 'low' ? [] : buildRows(items, tab)),
    [items, tab],
  );

  const lowRows = useMemo(
    () => (tab === 'low' ? buildLowRows(items, thresholds) : []),
    [items, thresholds, tab],
  );

  const summary = useMemo(() => {
    const present = rows.reduce((sum, row) => sum + row.present, 0);
    const reserved = rows.reduce((sum, row) => sum + row.reserved, 0);
    return {
      products: rows.length,
      present,
      reserved,
      available: Math.max(present - reserved, 0),
    };
  }, [rows]);

  const lowSummary = useMemo(() => {
    return {
      products: lowRows.length,
      fbo: lowRows.filter((entry) => entry.fbo?.low).length,
      fbs: lowRows.filter((entry) => entry.fbs?.low).length,
    };
  }, [lowRows]);

  const visibleRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? rows.filter((row) => {
          const item = row.item;
          const haystack = [item.name, item.offer_id, item.sku !== null ? String(item.sku) : '']
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
      : rows;

    return [...filtered].sort((a, b) => {
      if (sortByStock && a.available !== b.available) return b.available - a.available;
      return a.item.name.localeCompare(b.item.name, i18n.language, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }, [rows, search, sortByStock, i18n.language]);

  const visibleLowRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? lowRows.filter((entry) => {
          const item = entry.item;
          const haystack = [item.name, item.offer_id, item.sku !== null ? String(item.sku) : '']
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
      : lowRows;

    return [...filtered].sort((a, b) => {
      if (sortByStock) {
        const aMin = entryMinAvailable(a);
        const bMin = entryMinAvailable(b);
        if (aMin !== bMin) return aMin - bMin;
      }
      return a.item.name.localeCompare(b.item.name, i18n.language, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }, [lowRows, search, sortByStock, i18n.language]);

  const toggleExpanded = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const data = stocksQuery.data;
  const loading = stocksQuery.isLoading;
  const refreshing = refreshMutation.isPending;

  return (
    <div className="p-6 max-w-screen-2xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('ozonPage.title')}</h1>
          <p className="text-sm text-bambu-gray mt-1 max-w-2xl">{t('ozonPage.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canManageSettings && (
            <Button variant="secondary" onClick={() => setSettingsOpen(true)}>
              <SettingsIcon className="w-4 h-4" />
              {t('ozonPage.connection')}
            </Button>
          )}
          {data?.configured && data.enabled && (
            <Button
              variant="secondary"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              {t('common.refresh')}
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 text-bambu-green animate-spin" />
        </div>
      ) : stocksQuery.isError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <AlertTriangle className="w-10 h-10 text-red-400" />
            <p className="text-white">{errorMessage(stocksQuery.error, t)}</p>
            <Button variant="secondary" onClick={() => stocksQuery.refetch()}>
              <RefreshCw className="w-4 h-4" />
              {t('common.retry')}
            </Button>
          </CardContent>
        </Card>
      ) : !data?.configured ? (
        <EmptyState
          title={t('ozonPage.notConnectedTitle')}
          body={t('ozonPage.notConnectedBody')}
          action={
            canManageSettings
              ? { label: t('ozonPage.openSettings'), onClick: () => setSettingsOpen(true) }
              : undefined
          }
        />
      ) : !data.enabled ? (
        <EmptyState
          title={t('ozonPage.disabledTitle')}
          body={t('ozonPage.disabledBody')}
          action={
            canManageSettings
              ? { label: t('ozonPage.openSettings'), onClick: () => setSettingsOpen(true) }
              : undefined
          }
        />
      ) : (
        <>
          <div className="flex border-b border-bambu-dark-tertiary mb-4" role="tablist">
            {TABS.map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={tab === option}
                onClick={() => setTab(option)}
                className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  tab === option
                    ? 'text-bambu-green border-bambu-green'
                    : 'text-bambu-gray hover:text-white border-transparent'
                }`}
              >
                {tabLabel(option, t)}
              </button>
            ))}
          </div>

          {tab === 'low' ? (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
              <SummaryCard
                label={t('ozonPage.lowProducts')}
                value={number(lowSummary.products, i18n.language)}
                highlight
              />
              <SummaryCard
                label={t('ozonPage.lowFbo')}
                value={number(lowSummary.fbo, i18n.language)}
              />
              <SummaryCard
                label={t('ozonPage.lowFbs')}
                value={number(lowSummary.fbs, i18n.language)}
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <SummaryCard
                label={t('ozonPage.products')}
                value={number(summary.products, i18n.language)}
              />
              <SummaryCard
                label={t('ozonPage.inStock')}
                value={number(summary.present, i18n.language)}
              />
              <SummaryCard
                label={t('ozonPage.reserved')}
                value={number(summary.reserved, i18n.language)}
              />
              <SummaryCard
                label={t('ozonPage.available')}
                value={number(summary.available, i18n.language)}
                highlight
              />
            </div>
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('ozonPage.searchPlaceholder')}
                className="w-full pl-9 pr-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white placeholder-bambu-gray/50 focus:border-bambu-green focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-3">
              {data.fetched_at && (
                <span className="text-xs text-bambu-gray">
                  {t('ozonPage.updatedAt', { time: new Date(data.fetched_at).toLocaleString() })}
                  {data.cached ? ` (${t('ozonPage.cached')})` : ''}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSortByStock((current) => !current)}
              >
                {sortByStock ? t('ozonPage.available') : t('common.name')}
              </Button>
            </div>
          </div>

          {tab === 'low' ? (
            thresholds.fbo <= 0 && thresholds.fbs <= 0 ? (
              <EmptyState
                title={t('ozonPage.lowNoThreshold')}
                action={
                  canManageSettings
                    ? { label: t('ozonPage.openSettings'), onClick: () => setSettingsOpen(true) }
                    : undefined
                }
              />
            ) : lowRows.length === 0 ? (
              <EmptyState title={t('ozonPage.lowEmpty')} />
            ) : visibleLowRows.length === 0 ? (
              <EmptyState title={t('ozonPage.noResults', { query: search.trim() })} />
            ) : (
              <Card className="overflow-hidden">
                <ul>
                  {visibleLowRows.map((entry) => (
                    <LowStockRow
                      key={itemKey(entry.item)}
                      entry={entry}
                      locale={i18n.language}
                    />
                  ))}
                </ul>
              </Card>
            )
          ) : items.length === 0 ? (
            <EmptyState title={t('ozonPage.empty')} />
          ) : rows.length === 0 ? (
            <EmptyState
              title={
                tab === 'all'
                  ? t('ozonPage.empty')
                  : t('ozonPage.noScheme', { scheme: tab.toUpperCase() })
              }
            />
          ) : visibleRows.length === 0 ? (
            <EmptyState title={t('ozonPage.noResults', { query: search.trim() })} />
          ) : (
            <Card className="overflow-hidden">
              <ul>
                {visibleRows.map((row) => (
                  <StockRow
                    key={itemKey(row.item)}
                    row={row}
                    locale={i18n.language}
                    expanded={expanded.has(itemKey(row.item))}
                    onToggle={() => toggleExpanded(itemKey(row.item))}
                  />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {settingsOpen && <OzonSettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs uppercase tracking-wide text-bambu-gray">{label}</p>
        <p className={`text-2xl font-semibold mt-1 ${highlight ? 'text-bambu-green' : 'text-white'}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <Package className="w-10 h-10 text-bambu-gray" />
        <p className="text-white font-medium">{title}</p>
        {body && <p className="text-sm text-bambu-gray max-w-lg">{body}</p>}
        {action && (
          <Button variant="secondary" onClick={action.onClick}>
            <SettingsIcon className="w-4 h-4" />
            {action.label}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function StockRow({
  row,
  locale,
  expanded,
  onToggle,
}: {
  row: SchemeRow;
  locale: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const { item, warehouses, present, reserved, available } = row;

  return (
    <li className="border-b border-bambu-dark-tertiary last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bambu-dark-tertiary/30 transition-colors"
      >
        <Chevron className="w-4 h-4 text-bambu-gray flex-shrink-0" />
        {item.image ? (
          <img
            src={ozonApi.thumbnailUrl(item.image)}
            alt=""
            loading="lazy"
            className="w-10 h-10 rounded object-cover bg-bambu-dark flex-shrink-0"
          />
        ) : (
          <div className="w-10 h-10 rounded bg-bambu-dark flex items-center justify-center flex-shrink-0">
            <Package className="w-5 h-5 text-bambu-gray" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-white truncate">{item.name}</p>
          <p className="text-xs text-bambu-gray truncate">
            {t('ozonPage.article')}: {item.offer_id || '—'}
            {item.sku !== null && ` · SKU ${item.sku}`}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 md:gap-6 text-right flex-shrink-0">
          <RowNumber label={t('ozonPage.inStock')} value={present} locale={locale} />
          <RowNumber label={t('ozonPage.reserved')} value={reserved} locale={locale} />
          <RowNumber label={t('ozonPage.available')} value={available} locale={locale} highlight />
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pl-14">
          {warehouses.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('ozonPage.noWarehouses')}</p>
          ) : (
            <div className="rounded-lg border border-bambu-dark-tertiary overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-bambu-dark-tertiary/40 text-bambu-gray">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">
                      {t('ozonPage.warehouses')}
                    </th>
                    <th className="text-left font-medium px-3 py-2 hidden sm:table-cell">
                      {t('ozonPage.scheme')}
                    </th>
                    <th className="text-right font-medium px-3 py-2">{t('ozonPage.inStock')}</th>
                    <th className="text-right font-medium px-3 py-2">{t('ozonPage.reserved')}</th>
                  </tr>
                </thead>
                <tbody>
                  {warehouses.map((warehouse, index) => (
                    <tr
                      key={`${warehouse.warehouse_id ?? 'w'}-${index}`}
                      className="border-t border-bambu-dark-tertiary"
                    >
                      <td className="px-3 py-2 text-white">
                        <span className="inline-flex items-center gap-2">
                          <Warehouse className="w-4 h-4 text-bambu-gray" />
                          {warehouse.warehouse_name ||
                            (warehouse.warehouse_id !== null
                              ? String(warehouse.warehouse_id)
                              : '—')}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-bambu-gray hidden sm:table-cell">
                        {warehouse.type || '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-white">
                        {number(warehouse.present, locale)}
                      </td>
                      <td className="px-3 py-2 text-right text-white">
                        {number(warehouse.reserved, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function RowNumber({
  label,
  value,
  locale,
  highlight,
}: {
  label: string;
  value: number;
  locale: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-bambu-gray hidden md:block">
        {label}
      </p>
      <p
        className={`text-sm font-semibold tabular-nums ${
          highlight ? 'text-bambu-green' : 'text-white'
        }`}
      >
        {number(value, locale)}
      </p>
    </div>
  );
}

function LowStockRow({ entry, locale }: { entry: LowStockEntry; locale: string }) {
  const { t } = useTranslation();
  const { item, fbo, fbs } = entry;
  const total = (fbo?.available ?? 0) + (fbs?.available ?? 0);

  return (
    <li className="border-b border-bambu-dark-tertiary last:border-b-0">
      <div className="w-full flex items-center gap-3 px-4 py-3">
        {item.image ? (
          <img
            src={ozonApi.thumbnailUrl(item.image)}
            alt=""
            loading="lazy"
            className="w-10 h-10 rounded object-cover bg-bambu-dark flex-shrink-0"
          />
        ) : (
          <div className="w-10 h-10 rounded bg-bambu-dark flex items-center justify-center flex-shrink-0">
            <Package className="w-5 h-5 text-bambu-gray" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-white truncate">{item.name}</p>
          <p className="text-xs text-bambu-gray truncate">
            {t('ozonPage.article')}: {item.offer_id || '—'}
            {item.sku !== null && ` · SKU ${item.sku}`}
          </p>
        </div>
        <div className="flex items-center gap-4 md:gap-6 flex-shrink-0">
          <SchemeStockCell label="FBO" stock={fbo} locale={locale} />
          <SchemeStockCell label="FBS" stock={fbs} locale={locale} />
          <TotalCell label={t('ozonPage.lowTotal')} value={total} locale={locale} />
        </div>
      </div>
    </li>
  );
}

function TotalCell({ label, value, locale }: { label: string; value: number; locale: string }) {
  return (
    <div className="text-right min-w-[64px]">
      <p className="text-[10px] uppercase tracking-wide text-bambu-gray">{label}</p>
      <p data-testid="low-total" className="text-sm font-semibold tabular-nums text-bambu-green">
        {number(value, locale)}
      </p>
    </div>
  );
}

function SchemeStockCell({
  label,
  stock,
  locale,
}: {
  label: string;
  stock: SchemeStock | null;
  locale: string;
}) {
  const { t } = useTranslation();

  if (stock === null) {
    return (
      <div className="text-right min-w-[64px]">
        <p className="text-[10px] uppercase tracking-wide text-bambu-gray">{label}</p>
        <p className="text-sm text-bambu-gray">—</p>
      </div>
    );
  }

  return (
    <div className="text-right min-w-[64px]">
      <p className="text-[10px] uppercase tracking-wide text-bambu-gray">{label}</p>
      <p
        className={`text-sm font-semibold tabular-nums ${stock.low ? 'text-red-400' : 'text-white'}`}
        title={
          stock.low
            ? t('ozonPage.lowBadgeTitle', {
                scheme: label,
                available: number(stock.available, locale),
                threshold: number(stock.threshold, locale),
              })
            : undefined
        }
      >
        {number(stock.available, locale)}
        {stock.low && (
          <span className="text-red-400">
            {' '}
            &lt; {number(stock.threshold, locale)}
          </span>
        )}
      </p>
    </div>
  );
}

function OzonSettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [enabled, setEnabled] = useState(false);
  const [clientId, setClientId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [thresholdFbo, setThresholdFbo] = useState('0');
  const [thresholdFbs, setThresholdFbs] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['ozon-settings'],
    queryFn: () => ozonApi.getSettings(),
  });

  useEffect(() => {
    if (!settingsQuery.data) return;
    setEnabled(settingsQuery.data.enabled);
    setClientId(settingsQuery.data.client_id);
    setThresholdFbo(String(settingsQuery.data.low_stock_threshold_fbo));
    setThresholdFbs(String(settingsQuery.data.low_stock_threshold_fbs));
  }, [settingsQuery.data]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const testMutation = useMutation({
    mutationFn: () =>
      ozonApi.test({ client_id: clientId, api_key: apiKey || undefined }),
    onSuccess: (result) => {
      setError(null);
      setTestResult(t('ozonPage.testOk', { count: result.warehouses }));
    },
    onError: (err) => {
      setTestResult(null);
      setError(errorMessage(err, t));
    },
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      ozonApi.updateSettings({
        enabled,
        client_id: clientId,
        api_key: apiKey || undefined,
        low_stock_threshold_fbo: parseInt(thresholdFbo, 10) || 0,
        low_stock_threshold_fbs: parseInt(thresholdFbs, 10) || 0,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ozon-settings'] });
      queryClient.invalidateQueries({ queryKey: ['ozon-stocks'] });
      showToast(t('ozonPage.saved'));
      onClose();
    },
    onError: (err) => {
      setError(errorMessage(err, t));
    },
  });

  const apiKeyStored = settingsQuery.data?.api_key_set ?? false;
  const busy = testMutation.isPending || saveMutation.isPending;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-bambu-dark-tertiary">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-full bg-bambu-green/20 text-bambu-green">
              <SettingsIcon className="w-5 h-5" />
            </div>
            <h2 className="text-lg font-semibold text-white">{t('ozonPage.settingsTitle')}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-bambu-gray hover:text-white transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-bambu-gray">{t('ozonPage.settingsIntro')}</p>

          {settingsQuery.isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-6 h-6 text-bambu-green animate-spin" />
            </div>
          ) : settingsQuery.isError ? (
            <p className="text-sm text-red-400">{errorMessage(settingsQuery.error, t)}</p>
          ) : (
            <>
              <div className="flex items-center justify-between pt-2 border-t border-bambu-dark-tertiary">
                <span className="text-sm text-white">{t('ozonPage.enabled')}</span>
                <Toggle checked={enabled} onChange={setEnabled} disabled={busy} />
              </div>

              <div>
                <label
                  className="block text-sm text-bambu-gray mb-1"
                  htmlFor="ozon-client-id"
                >
                  {t('ozonPage.clientId')}
                </label>
                <input
                  id="ozon-client-id"
                  type="text"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  autoComplete="off"
                  className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                />
                <p className="text-xs text-bambu-gray mt-1">{t('ozonPage.clientIdHint')}</p>
              </div>

              <div>
                <label className="block text-sm text-bambu-gray mb-1" htmlFor="ozon-api-key">
                  {t('ozonPage.apiKey')}
                </label>
                <input
                  id="ozon-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="new-password"
                  placeholder={apiKeyStored ? '••••••••' : ''}
                  className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white placeholder-bambu-gray/50 focus:border-bambu-green focus:outline-none"
                />
                <p className="text-xs text-bambu-gray mt-1">
                  {apiKeyStored ? t('ozonPage.apiKeyStored') : t('ozonPage.apiKeyHint')}
                </p>
              </div>

              <div className="pt-2 border-t border-bambu-dark-tertiary">
                <p className="text-sm text-white mb-3">{t('ozonPage.thresholdIntro')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      className="block text-sm text-bambu-gray mb-1"
                      htmlFor="ozon-threshold-fbo"
                    >
                      {t('ozonPage.thresholdFbo')}
                    </label>
                    <input
                      id="ozon-threshold-fbo"
                      type="number"
                      min="0"
                      value={thresholdFbo}
                      onChange={(event) => setThresholdFbo(event.target.value)}
                      className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      className="block text-sm text-bambu-gray mb-1"
                      htmlFor="ozon-threshold-fbs"
                    >
                      {t('ozonPage.thresholdFbs')}
                    </label>
                    <input
                      id="ozon-threshold-fbs"
                      type="number"
                      min="0"
                      value={thresholdFbs}
                      onChange={(event) => setThresholdFbs(event.target.value)}
                      className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
                    />
                  </div>
                </div>
                <p className="text-xs text-bambu-gray mt-2">{t('ozonPage.thresholdHint')}</p>
              </div>

              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/40 rounded-lg text-sm text-red-400">
                  {error}
                </div>
              )}
              {testResult && (
                <div className="p-3 bg-bambu-green/10 border border-bambu-green/40 rounded-lg text-sm text-bambu-green">
                  {testResult}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => testMutation.mutate()}
                  disabled={
                    busy || !clientId.trim() || (!apiKey.trim() && !apiKeyStored)
                  }
                >
                  {testMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  {t('ozonPage.testConnection')}
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  onClick={() => saveMutation.mutate()}
                  disabled={busy}
                >
                  {saveMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  {t('common.save')}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
