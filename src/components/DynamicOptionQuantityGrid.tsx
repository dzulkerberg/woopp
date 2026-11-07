import React, { useEffect, useMemo, useState } from 'react';
import { CatalogProduct } from '../types';
import {
  buildCatalogSelectionKey,
  isAlphabetProductItems,
  PlannableProductItem,
} from '../utils/catalogPlannerEngine';

export interface DynamicOptionQuantityGridProps {
  product: CatalogProduct;
  items: PlannableProductItem[];
  quantitiesByKey: Record<string, number>;
  hasMultipleGroups: boolean;
  onChangeQuantity: (selectionKey: string, nextQty: number) => void;
  onDirty: () => void;
}

/**
 * Reusable, responsive product variation quantity input grid.
 *
 * Design features:
 * - Clean, premium SaaS manufacturing aesthetic with subtle borders and clear contrast.
 * - Fluid CSS Grid with responsive auto-fitting columns (`repeat(auto-fill, minmax(min(100%, ...), 1fr))`).
 * - On desktop widths, yields ~6–8 columns for short labels (letters, codes) and adapts gracefully for longer labels.
 * - Standardized, balanced card height, padding, and layout across all products.
 * - Input fields comfortably display 4-digit numbers with clear typography and browser spinner controls.
 * - Full text wrapping for longer labels without clipping or horizontal overflow.
 * - Multi-group option selector tabs (e.g. Color, Finish, Style) with live subtotals.
 */
export const DynamicOptionQuantityGrid: React.FC<DynamicOptionQuantityGridProps> = ({
  product,
  items,
  quantitiesByKey,
  hasMultipleGroups,
  onChangeQuantity,
  onDirty,
}) => {
  const isAlphabet = useMemo(() => isAlphabetProductItems(items), [items]);

  // Secondary option group handling (e.g., Letter + Color)
  const secondaryGroup = hasMultipleGroups && product.options ? product.options[1] : null;
  const [activeSecondaryValue, setActiveSecondaryValue] = useState<string>(
    secondaryGroup && secondaryGroup.values.length > 0 ? secondaryGroup.values[0] : ''
  );

  useEffect(() => {
    if (secondaryGroup && secondaryGroup.values.length > 0) {
      if (!secondaryGroup.values.includes(activeSecondaryValue)) {
        setActiveSecondaryValue(secondaryGroup.values[0]);
      }
    }
  }, [secondaryGroup, activeSecondaryValue]);

  // Filter items if secondary group is active
  const displayedItems = useMemo(() => {
    if (!secondaryGroup || !activeSecondaryValue) {
      return items;
    }
    return items.filter((item) => {
      if (!item.optionValues) return true;
      return item.optionValues[secondaryGroup.name] === activeSecondaryValue;
    });
  }, [items, secondaryGroup, activeSecondaryValue]);

  const isAlphabetSubset = useMemo(
    () => isAlphabetProductItems(displayedItems),
    [displayedItems]
  );

  // Determine whether this option set consists of short labels (e.g. A–Z, 01, XS) or multi-word labels
  const isShortOptionSet = useMemo(() => {
    if (isAlphabet || isAlphabetSubset) return true;
    return (
      displayedItems.length > 0 &&
      displayedItems.every((it) => it.label.trim().length <= 3)
    );
  }, [isAlphabet, isAlphabetSubset, displayedItems]);

  return (
    <div className="space-y-3.5 pt-3 border-t border-line/70">
      {/* Secondary Option Selector Tabs (e.g. Color / Finish / Material) */}
      {secondaryGroup && secondaryGroup.values.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-ink-secondary">
            Select {secondaryGroup.name}:
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {secondaryGroup.values.map((val) => {
              const tabItems = items.filter(
                (item) => item.optionValues?.[secondaryGroup.name] === val
              );
              const tabTotal = tabItems.reduce((sum, item) => {
                const k = buildCatalogSelectionKey(product.id, item.id);
                return sum + (quantitiesByKey[k] ?? 0);
              }, 0);
              const isActive = activeSecondaryValue === val;

              return (
                <button
                  key={val}
                  type="button"
                  onClick={() => setActiveSecondaryValue(val)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 whitespace-nowrap ${
                    isActive
                      ? 'border-brand bg-brand-soft text-brand-text font-bold ring-1 ring-brand'
                      : 'border-line bg-surface hover:bg-elevated text-ink'
                  }`}
                >
                  <span>{val}</span>
                  {tabTotal > 0 && (
                    <span className="text-[10px] font-mono-data px-1.5 py-0.5 rounded-full bg-brand text-white font-semibold">
                      {tabTotal}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Responsive Grid with Sensible Card Widths & Balanced Sizing */}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: isShortOptionSet
            ? 'repeat(auto-fill, minmax(min(100%, 88px), 1fr))'
            : 'repeat(auto-fill, minmax(min(100%, 160px), 1fr))',
        }}
      >
        {displayedItems.map((item) => {
          const key = buildCatalogSelectionKey(product.id, item.id);
          const qty = quantitiesByKey[key] ?? 0;
          const isSingleShort = isShortOptionSet && item.label.length <= 3;

          return (
            <div
              key={item.id}
              className={`group relative rounded-xl border p-2.5 sm:p-3 flex flex-col justify-between transition-all ${
                isSingleShort ? 'items-center text-center' : 'items-stretch'
              } ${
                qty > 0
                  ? 'border-brand-border bg-brand-soft/60 ring-1 ring-brand/40 shadow-xs'
                  : 'border-line/90 bg-surface hover:border-brand-border/60 hover:bg-elevated/70'
              }`}
            >
              {/* Option label: legible, well-spaced, wrapping smoothly without clipping */}
              <div
                className={`font-semibold text-ink leading-snug select-none mb-2.5 ${
                  isSingleShort
                    ? 'text-sm font-bold tracking-tight text-center truncate max-w-full'
                    : 'text-xs text-left break-words'
                }`}
                title={item.label}
              >
                {item.label}
              </div>

              {/* Quantity input: readable 4-digit display with spinner controls and active badge */}
              <div className={isSingleShort ? 'w-full' : 'w-full flex justify-end'}>
                <input
                  type="number"
                  min={0}
                  step={1}
                  placeholder="0"
                  aria-label={`Quantity for ${product.name} (${item.label})`}
                  value={qty === 0 ? '' : qty}
                  onChange={(e) => {
                    const parsed = Math.max(0, Math.floor(Number(e.target.value) || 0));
                    onChangeQuantity(key, parsed);
                    onDirty();
                  }}
                  className={`min-w-[76px] h-8 px-2 py-1 rounded-lg border border-line bg-input text-xs font-mono-data font-semibold text-ink focus:border-brand focus:ring-1 focus:ring-brand/40 focus:outline-none placeholder:text-muted/50 transition-colors ${
                    isSingleShort ? 'w-full text-center' : 'w-full sm:w-24 text-right'
                  }`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
