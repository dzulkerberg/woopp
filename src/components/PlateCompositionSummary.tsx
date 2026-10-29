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
      <span className="text-[11px] text-neutral-400 dark:text-neutral-500 font-mono-data">
        0 keycaps
      </span>
    );
  }

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono-data">
        {letterEntries.length > 0 && (
          <span className="text-neutral-600 dark:text-neutral-300">
            <span className="font-semibold text-neutral-800 dark:text-neutral-200">
              A–Z ({alphabetTotal}):
            </span>{' '}
            {letterEntries.map((e) => `${e.key}×${e.qty}`).join(' · ')}
          </span>
        )}
        {charmEntries.length > 0 && (
          <span className="text-[#5b3cc4] dark:text-[#c7b8ff]">
            <span className="font-semibold">Charms ({charmTotal}):</span>{' '}
            {charmEntries.map((c) => `${c.symbol} ${c.label}×${c.qty}`).join(' · ')}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 text-[11px] font-mono-data">
      {letterEntries.length > 0 && (
        <div className="text-neutral-700 dark:text-neutral-300 leading-relaxed break-words">
          {charmEntries.length > 0 && (
            <span className="font-sans font-semibold text-neutral-500 dark:text-neutral-400 mr-1.5">
              Alphabet ({alphabetTotal}):
            </span>
          )}
          {letterEntries.map((e) => `${e.key}×${e.qty}`).join(' · ')}
        </div>
      )}

      {charmEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {letterEntries.length > 0 && (
            <span className="font-sans font-semibold text-[#5b3cc4] dark:text-[#c7b8ff] mr-0.5">
              Charms ({charmTotal}):
            </span>
          )}
          {charmEntries.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[#f5f2ff] dark:bg-[#251f3d] border border-[#e3dbfc] dark:border-[#3c3163] text-[#4c32a8] dark:text-[#d5c8ff]"
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
