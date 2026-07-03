import type { ReactNode } from 'react';
import './AmountField.css';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: 'decimal' | 'numeric' | 'text';
  availableLabel?: ReactNode;
  shortfallLabel?: ReactNode;
  hint?: string;
}

export function AmountField({
  label,
  value,
  onChange,
  placeholder,
  inputMode = 'decimal',
  availableLabel,
  shortfallLabel,
  hint,
}: Props) {
  return (
    <div className="field amount-field">
      <label>{label}</label>
      <input
        className={`amount-field-input ${shortfallLabel ? 'amount-field-input--error' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={inputMode}
        placeholder={placeholder}
      />
      {availableLabel ? (
        <span className={`amount-field-available ${shortfallLabel ? 'amount-field-available--warn' : ''}`}>
          {availableLabel}
        </span>
      ) : null}
      {shortfallLabel ? <span className="amount-field-shortfall">{shortfallLabel}</span> : null}
      {hint ? <span className="form-hint">{hint}</span> : null}
    </div>
  );
}