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
import type { OzonStockItem } from '../api/client';
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

export function OzonPage() {
  const { t, i18n } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [sortByStock, setSortByStock] = useState(false);
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

  const visibleItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? items.filter((item) => {
          const haystack = [item.name, item.offer_id, item.sku !== null ? String(item.sku) : '']
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
      : items;

    return [...filtered].sort((a, b) => {
      if (sortByStock && a.available !== b.available) return b.available - a.available;
      return a.name.localeCompare(b.name, i18n.language, { numeric: true, sensitivity: 'base' });
    });
  }, [items, search, sortByStock, i18n.language]);

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
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <SummaryCard
              label={t('ozonPage.products')}
              value={number(data.total_products, i18n.language)}
            />
            <SummaryCard
              label={t('ozonPage.inStock')}
              value={number(data.total_present, i18n.language)}
            />
            <SummaryCard
              label={t('ozonPage.reserved')}
              value={number(data.total_reserved, i18n.language)}
            />
            <SummaryCard
              label={t('ozonPage.available')}
              value={number(Math.max(data.total_present - data.total_reserved, 0), i18n.language)}
              highlight
            />
          </div>

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

          {items.length === 0 ? (
            <EmptyState title={t('ozonPage.empty')} />
          ) : visibleItems.length === 0 ? (
            <EmptyState title={t('ozonPage.noResults', { query: search.trim() })} />
          ) : (
            <Card className="overflow-hidden">
              <ul>
                {visibleItems.map((item) => (
                  <StockRow
                    key={itemKey(item)}
                    item={item}
                    locale={i18n.language}
                    expanded={expanded.has(itemKey(item))}
                    onToggle={() => toggleExpanded(itemKey(item))}
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
  item,
  locale,
  expanded,
  onToggle,
}: {
  item: OzonStockItem;
  locale: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const Chevron = expanded ? ChevronDown : ChevronRight;

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
            src={item.image}
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
          <RowNumber label={t('ozonPage.inStock')} value={item.present} locale={locale} />
          <RowNumber label={t('ozonPage.reserved')} value={item.reserved} locale={locale} />
          <RowNumber
            label={t('ozonPage.available')}
            value={item.available}
            locale={locale}
            highlight
          />
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pl-14">
          {item.warehouses.length === 0 ? (
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
                  {item.warehouses.map((warehouse, index) => (
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

function OzonSettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [enabled, setEnabled] = useState(false);
  const [clientId, setClientId] = useState('');
  const [apiKey, setApiKey] = useState('');
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
