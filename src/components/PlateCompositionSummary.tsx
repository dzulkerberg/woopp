import React from 'react';
import {
  ABC,
  CHARM_DEFINITIONS,
  countCharms,
  countLetters,
} from '../constants';
import { CharmsMap, LettersMap } from '../types';

interface PlateCompositionSummaryProps {
  letters?: LettersMap | null;
  charms?: CharmsMap | null;
  compact?: boolean;
}

export const PlateCompositionSummary: React.FC<PlateCompositionSummaryProps> = ({
  letters,
  charms,
  compact = false,
}) => {
  const letterEntries = ABC.filter((k) => Math.floor(Number(letters?.[k] || 0)) > 0).map(
    (k) => ({
      key: k,
      qty: Math.floor(Number(letters?.[k] || 0)),
    })
  );

  const charmEntries = CHARM_DEFINITIONS.filter(
    (def) => Math.floor(Number(charms?.[def.id] || 0)) > 0
  ).map((def) => ({
    ...def,
    qty: Math.floor(Number(charms?.[def.id] || 0)),
  }));

  const alphabetTotal = countLetters(letters);
  const charmTotal = countCharms(charms);

  if (letterEntries.length === 0 && charmEntries.length === 0) {
    return (
      <span className="text-[11px] text-muted font-mono-data">
        0 keycaps
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
      </div>
    );
  }

  return (
    <div className="space-y-1.5 text-[11px] font-mono-data min-w-0">
      {letterEntries.length > 0 && (
        <div className="text-ink-secondary leading-relaxed break-words">
          {charmEntries.length > 0 && (
            <span className="font-sans font-semibold text-muted mr-1.5">
              Alphabet ({alphabetTotal}):
            </span>
          )}
          {letterEntries.map((e) => `${e.key}×${e.qty}`).join(' · ')}
        </div>
      )}

      {charmEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {letterEntries.length > 0 && (
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
    </div>
  );
};
