import React, { useState } from 'react';
import { EtaRecalibrationInput } from '../types';
import {
  formatDateTimeLocalInput,
  parseDateTimeLocalInputToUtcMs,
} from '../utils/dateFormat';
import { ETA_NEEDS_RECALIBRATION_LABEL } from '../utils/productionCountdown';
import { DurationHMInput } from './DurationHMInput';

interface EtaRecalibrationBoxProps {
  jobId: string;
  plateNumber: number;
  defaultDurationMinutes: number;
  nowMs: number;
  timezone: string;
  compact?: boolean;
  disabled?: boolean;
  onRecalibrate: (jobId: string, input: EtaRecalibrationInput) => void;
}

export const EtaRecalibrationBox: React.FC<EtaRecalibrationBoxProps> = ({
  jobId,
  plateNumber,
  defaultDurationMinutes,
  nowMs,
  timezone,
  compact = false,
  disabled = false,
  onRecalibrate,
}) => {
  const [mode, setMode] = useState<'remaining_duration' | 'actual_start_time'>(
    'remaining_duration'
  );
  const [remainingMinutes, setRemainingMinutes] = useState<number>(() =>
    Math.max(1, Math.round(defaultDurationMinutes || 60))
  );
  const [startDateTimeInput, setStartDateTimeInput] = useState<string>(() =>
    formatDateTimeLocalInput(Math.max(0, nowMs - 30 * 60_000), timezone)
  );
  const [inputError, setInputError] = useState<string | null>(null);

  const handleApply = () => {
    setInputError(null);
    if (mode === 'remaining_duration') {
      onRecalibrate(jobId, {
        mode: 'remaining_duration',
        remainingMinutes: Math.max(0, remainingMinutes),
      });
      return;
    }

    const parsedUtcMs = parseDateTimeLocalInputToUtcMs(startDateTimeInput, timezone);
    if (parsedUtcMs === null) {
      setInputError('Enter a valid start date and time.');
      return;
    }
    if (parsedUtcMs > nowMs + 60_000) {
      setInputError('Actual start time cannot be in the future.');
      return;
    }
    onRecalibrate(jobId, {
      mode: 'actual_start_time',
      actualStartedAtMs: parsedUtcMs,
    });
  };

  return (
    <div
      className={`min-w-0 max-w-full rounded-lg border border-amber-300 dark:border-amber-700/80 bg-amber-50/80 dark:bg-amber-950/35 ${
        compact ? 'p-2.5 space-y-2' : 'p-3.5 space-y-2.5'
      } text-xs`}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5 min-w-0">
        <span className="font-semibold text-amber-900 dark:text-amber-200 break-words">
          {ETA_NEEDS_RECALIBRATION_LABEL}
        </span>
        <div className="flex flex-wrap gap-0.5 rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-[#171522] p-0.5 text-[11px] min-w-0 max-w-full">
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setMode('remaining_duration');
              setInputError(null);
            }}
            className={`grow px-2 py-0.5 rounded font-medium text-center leading-tight break-words ${
              mode === 'remaining_duration'
                ? 'bg-amber-600 text-white'
                : 'text-neutral-600 dark:text-neutral-300'
            }`}
          >
            Remaining Time
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setMode('actual_start_time');
              setInputError(null);
            }}
            className={`grow px-2 py-0.5 rounded font-medium text-center leading-tight break-words ${
              mode === 'actual_start_time'
                ? 'bg-amber-600 text-white'
                : 'text-neutral-600 dark:text-neutral-300'
            }`}
          >
            Actual Start
          </button>
        </div>
      </div>

      <p className="text-[11px] text-amber-800/90 dark:text-amber-300/90 break-words">
        This active print lacks a calibrated start/finish timestamp. Enter either the remaining print time on Bambu Studio or the actual start time ({timezone}).
      </p>

      {mode === 'remaining_duration' ? (
        <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <DurationHMInput
            compact
            minutes={remainingMinutes}
            onChangeMinutes={setRemainingMinutes}
            ariaLabelPrefix={`Recalibrate remaining time for Plate ${plateNumber}`}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={handleApply}
            className="w-full sm:w-auto grow sm:grow-0 inline-flex items-center justify-center px-2.5 py-1 text-xs font-semibold rounded-lg bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-50 text-center leading-tight"
          >
            Save ETA
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <input
            type="datetime-local"
            aria-label={`Actual start time for Plate ${plateNumber}`}
            value={startDateTimeInput}
            onChange={(e) => {
              setStartDateTimeInput(e.target.value);
              setInputError(null);
            }}
            className="w-full sm:w-auto flex-1 min-w-0 max-w-full px-2 py-1 rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-[#171522] font-mono-data text-xs text-neutral-900 dark:text-white"
          />
          <button
            type="button"
            disabled={disabled}
            onClick={handleApply}
            className="w-full sm:w-auto grow sm:grow-0 inline-flex items-center justify-center px-2.5 py-1 text-xs font-semibold rounded-lg bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-50 text-center leading-tight"
          >
            Save Start
          </button>
        </div>
      )}

      {inputError && (
        <div className="text-[11px] font-medium text-red-600 dark:text-red-400">
          {inputError}
        </div>
      )}
    </div>
  );
};
