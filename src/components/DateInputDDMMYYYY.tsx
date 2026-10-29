import React, { useEffect, useRef, useState } from 'react';
import { Calendar } from 'lucide-react';
import { formatDateDDMMYYYY, toComparableYYYYMMDD } from '../utils/dateFormat';

interface DateInputDDMMYYYYProps {
  value: string; // Stored as YYYY-MM-DD or ''
  onChange: (isoDate: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * Displays and accepts dates strictly in DD/MM/YYYY format while also offering a native calendar picker button.
 * Emits normalized YYYY-MM-DD (or '') to `onChange`.
 */
export const DateInputDDMMYYYY: React.FC<DateInputDDMMYYYYProps> = ({
  value,
  onChange,
  placeholder = 'DD/MM/YYYY',
  ariaLabel,
  className = '',
}) => {
  const [text, setText] = useState<string>(() => formatDateDDMMYYYY(value));
  const nativePickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(formatDateDDMMYYYY(value));
  }, [value]);

  const handleTextChange = (raw: string) => {
    // Auto-insert slashes when typing digits cleanly
    const cleaned = raw.replace(/[^\d/]/g, '').slice(0, 10);
    setText(cleaned);

    if (cleaned === '') {
      onChange('');
      return;
    }

    if (/^\d{2}\/\d{2}\/\d{4}$/.test(cleaned)) {
      const iso = toComparableYYYYMMDD(cleaned);
      if (iso) {
        onChange(iso);
      }
    }
  };

  const handleBlur = () => {
    if (!text.trim()) {
      setText('');
      onChange('');
      return;
    }
    const iso = toComparableYYYYMMDD(text);
    if (iso) {
      onChange(iso);
      setText(formatDateDDMMYYYY(iso));
    } else {
      // Revert to last valid value
      setText(formatDateDDMMYYYY(value));
    }
  };

  return (
    <div className={`relative flex items-center ${className}`}>
      <input
        type="text"
        inputMode="numeric"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={text}
        onChange={(e) => handleTextChange(e.target.value)}
        onBlur={handleBlur}
        className="w-full pr-8 px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-xs sm:text-sm text-neutral-900 dark:text-white font-mono-data"
      />
      <button
        type="button"
        onClick={() => {
          const el = nativePickerRef.current;
          if (!el) return;
          if (typeof el.showPicker === 'function') {
            el.showPicker();
          } else {
            el.focus();
            el.click();
          }
        }}
        className="absolute right-2 p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        title="Pick date from calendar"
        aria-label="Open calendar picker"
      >
        <Calendar className="w-3.5 h-3.5" />
      </button>
      <input
        ref={nativePickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={toComparableYYYYMMDD(value)}
        onChange={(e) => {
          const picked = e.target.value;
          onChange(picked);
          setText(formatDateDDMMYYYY(picked));
        }}
        className="sr-only"
      />
    </div>
  );
};
