import React from 'react';
import { combineHMToMinutes, splitMinutesToHM } from '../utils/dateFormat';

interface DurationHMInputProps {
  minutes: number;
  onChangeMinutes: (nextTotalMinutes: number) => void;
  disabled?: boolean;
  compact?: boolean;
  ariaLabelPrefix?: string;
}

/**
 * Manual Bambu Studio Hours + Minutes input (`Xh Ym`).
 * Stores and emits unified integer minutes while letting operators enter Hours and Minutes directly.
 */
export const DurationHMInput: React.FC<DurationHMInputProps> = ({
  minutes,
  onChangeMinutes,
  disabled = false,
  compact = false,
  ariaLabelPrefix = 'Print duration',
}) => {
  const { hours, minutes: mins } = splitMinutesToHM(minutes);

  const handleHours = (val: string) => {
    const h = Math.max(0, Math.min(240, Math.floor(Number(val) || 0)));
    const combined = combineHMToMinutes(h, mins);
    onChangeMinutes(Math.max(1, combined));
  };

  const handleMins = (val: string) => {
    const m = Math.max(0, Math.min(59, Math.floor(Number(val) || 0)));
    const combined = combineHMToMinutes(hours, m);
    onChangeMinutes(Math.max(1, combined));
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <div className="flex items-center rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] px-2 py-1">
        <input
          type="number"
          min={0}
          max={240}
          disabled={disabled}
          aria-label={`${ariaLabelPrefix} hours`}
          value={hours}
          onChange={(e) => handleHours(e.target.value)}
          className={`${
            compact ? 'w-8 text-xs' : 'w-10 text-xs sm:text-sm'
          } text-right font-mono-data bg-transparent text-neutral-900 dark:text-white focus:outline-none`}
        />
        <span className="text-[11px] text-neutral-400 ml-1 select-none">h</span>
      </div>
      <div className="flex items-center rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] px-2 py-1">
        <input
          type="number"
          min={0}
          max={59}
          disabled={disabled}
          aria-label={`${ariaLabelPrefix} minutes`}
          value={mins}
          onChange={(e) => handleMins(e.target.value)}
          className={`${
            compact ? 'w-8 text-xs' : 'w-10 text-xs sm:text-sm'
          } text-right font-mono-data bg-transparent text-neutral-900 dark:text-white focus:outline-none`}
        />
        <span className="text-[11px] text-neutral-400 ml-1 select-none">m</span>
      </div>
    </div>
  );
};
