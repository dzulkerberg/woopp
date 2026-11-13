import React from 'react';
import {
  ABC,
  CHARM_DEFINITIONS,
  countCatalogItems,
  countCharms,
} from '../constants';
import { CharmsMap, JobCatalogItemSnapshot, LettersMap } from '../types';

interface PlateCompositionSummaryProps {
  letters?: LettersMap | null;
  charms?: CharmsMap | null;
  catalogItems?: readonly JobCatalogItemSnapshot[] | null;
  categoryNameSnapshot?: string | null;
  compact?: boolean;
}

export const PlateCompositionSummary: React.FC<PlateCompositionSummaryProps> = ({
  letters,
  charms,
  catalogItems,
  categoryNameSnapshot,
  compact = false,
}) => {
  const catalogEntries = Array.isArray(catalogItems)
    ? catalogItems.filter((ci) => Math.floor(Number(ci?.quantity || 0)) > 0)
    : [];

  const mirroredFromCatalog: Record<string, number> = {};
  for (const ci of catalogEntries) {
    const qty = Math.floor(Number(ci.quantity || 0));
    const upperLabel = (ci.variantLabel || '').trim().toUpperCase();
    if (qty > 0 && upperLabel.length === 1 && ABC.includes(upperLabel as any)) {
      mirroredFromCatalog[upperLabel] = (mirroredFromCatalog[upperLabel] || 0) + qty;
    }
  }

  const letterEntries = ABC.map((k) => {
    const rawQty = Math.floor(Number(letters?.[k] || 0));
    const extraQty = Math.max(0, rawQty - (mirroredFromCatalog[k] || 0));
    return { key: k, qty: extraQty };
  }).filter((entry) => entry.qty > 0);

  const charmEntries = CHARM_DEFINITIONS.filter(
    (def) => Math.floor(Number(charms?.[def.id] || 0)) > 0
  ).map((def) => ({
    ...def,
    qty: Math.floor(Number(charms?.[def.id] || 0)),
  }));

  const alphabetTotal = letterEntries.reduce((sum, e) => sum + e.qty, 0);
  const charmTotal = countCharms(charms);
  const catalogTotal = countCatalogItems(catalogEntries);

  if (
    letterEntries.length === 0 &&
    charmEntries.length === 0 &&
    catalogEntries.length === 0
  ) {
    return (
      <span className="text-[11px] text-muted font-mono-data">
        0 pcs
      </span>
    );
  }

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono-data min-w-0 break-words">
        {letterEntries.length > 0 && (
          <span className="text-ink-secondary min-w-0 break-words">
            <span className="font-semibold text-ink">
              A–Z ({alphabetTotal}):
            </span>{' '}
            {letterEntries.map((e) => `${e.key}×${e.qty}`).join(' · ')}
          </span>
        )}
        {charmEntries.length > 0 && (
          <span className="text-brand-text min-w-0 break-words">
            <span className="font-semibold">Charms ({charmTotal}):</span>{' '}
            {charmEntries.map((c) => `${c.symbol} ${c.label}×${c.qty}`).join(' · ')}
          </span>
        )}
        {catalogEntries.length > 0 && (
          <span className="text-ink min-w-0 break-words">
            <span className="font-semibold text-brand-text">
              {categoryNameSnapshot || catalogEntries[0]?.categoryName || 'Catalog'} ({catalogTotal}):
            </span>{' '}
            {catalogEntries
              .map(
                (ci) =>
                  `${ci.productName}${ci.variantLabel ? ` (${ci.variantLabel})` : ''}×${ci.quantity}`
              )
              .join(' · ')}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 text-[11px] font-mono-data min-w-0">
      {letterEntries.length > 0 && (
        <div className="text-ink-secondary leading-relaxed break-words">
          {(charmEntries.length > 0 || catalogEntries.length > 0) && (
            <span className="font-sans font-semibold text-muted mr-1.5">
              Alphabet ({alphabetTotal}):
            </span>
          )}
          {letterEntries.map((e) => `${e.key}×${e.qty}`).join(' · ')}
        </div>
      )}

      {charmEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {(letterEntries.length > 0 || catalogEntries.length > 0) && (
            <span className="font-sans font-semibold text-brand-text mr-0.5">
              Charms ({charmTotal}):
            </span>
          )}
          {charmEntries.map((c) => (
            <span
              key={c.id}
              className="inline-flex flex-wrap items-center gap-1 max-w-full px-1.5 py-0.5 rounded-md bg-brand-soft border border-brand-border text-brand-text break-words"
            >
              <span aria-hidden="true">{c.symbol}</span>
              <span className="font-sans text-[10px] font-semibold">{c.label}</span>
              <span className="font-bold">×{c.qty}</span>
            </span>
          ))}
        </div>
      )}

      {catalogEntries.length > 0 && (
        <div className="space-y-1 min-w-0">
          <div className="text-[10px] font-sans font-semibold text-muted">
            {categoryNameSnapshot || catalogEntries[0]?.categoryName || 'Product Studio'} ·{' '}
            <span className="font-mono-data text-brand-text">{catalogTotal} pcs</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            {catalogEntries.map((ci) => (
              <span
                key={`${ci.productId}:${ci.variantId || 'base'}`}
                className="inline-flex flex-wrap items-center gap-1 max-w-full px-2 py-0.5 rounded-md bg-elevated border border-line text-ink break-words"
              >
                <span className="font-sans text-[11px] font-semibold">
                  {ci.productName}
                </span>
                {ci.variantLabel && (
                  <span className="font-sans text-[10px] text-muted">
                    · {ci.variantLabel}
                  </span>
                )}
                <span className="text-[10px] text-muted">{ci.sku}</span>
                <span className="font-bold text-brand-text">×{ci.quantity}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
