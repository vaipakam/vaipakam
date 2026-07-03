import { CheckCircle2, AlertCircle } from 'lucide-react';

export interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  fixLabel?: string;
  onFix?: () => void;
}

interface Props {
  items: ChecklistItem[];
}

export function EligibilityChecklist({ items }: Props) {
  return (
    <div className="checklist" data-testid="eligibility-checklist">
      {items.map((item) => (
        <div key={item.id} className={`checklist-item ${item.ok ? 'ok' : 'fix'}`}>
          {item.ok ? <CheckCircle2 size={20} color="var(--accent-green)" /> : <AlertCircle size={20} color="var(--accent-orange)" />}
          <div style={{ flex: 1 }}>
            <div>{item.label}</div>
            {!item.ok && item.fixLabel ? (
              <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={item.onFix}>
                {item.fixLabel}
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}