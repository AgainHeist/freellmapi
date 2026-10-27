import { type CSSProperties, type ReactNode, useEffect } from 'react';

export function Card({ children, className = '', hover = false, style }: { children: ReactNode; className?: string; hover?: boolean; style?: CSSProperties }) {
  return <div className={`ab-card ${hover ? 'ab-card-hover' : ''} ${className}`} style={style}>{children}</div>;
}

export function Badge({ children, tone = '' }: { children: ReactNode; tone?: 'red' | 'green' | 'amber' | '' }) {
  const cls = tone ? `ab-badge ab-badge-${tone}` : 'ab-badge';
  return <span className={cls}>{children}</span>;
}

export function Button({
  children, onClick, variant = 'default', size = '', type = 'button', disabled, loading, className = '', title,
}: {
  children: ReactNode; onClick?: () => void; variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | ''; type?: 'button' | 'submit'; disabled?: boolean; loading?: boolean; className?: string; title?: string;
}) {
  const v = variant === 'default' ? '' : `ab-btn-${variant}`;
  return (
    <button
      type={type} title={title} disabled={disabled || loading} onClick={onClick}
      className={`ab-btn ${v} ${size === 'sm' ? 'ab-btn-sm' : ''} ${className}`}
    >
      {loading && <span className="ab-spinner" />}
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="ab-field">
      <label className="ab-label">{label}</label>
      {children}
      {hint && <div className="ab-form-note" style={{ marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);
  return (
    <div className="ab-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <Card className="ab-modal">
        <div className="ab-row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700 }}>{title}</h3>
          <button className="ab-btn ab-btn-ghost ab-btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
        {footer && <div className="ab-row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>{footer}</div>}
      </Card>
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="ab-table-wrap">
      <table className="ab-table">
        <thead><tr>{head.map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="ab-empty">{children}</div>;
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="ab-form-error">{message}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="ab-stat">
      <div className="ab-stat-value">{value}</div>
      <div className="ab-stat-label">{label}</div>
      {sub && <div className="ab-muted" style={{ fontSize: 11, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return <div className="ab-progress"><div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="ab-empty"><span className="ab-spinner" /> &nbsp;{label}</div>;
}

export function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: ReactNode; sub?: string }) {
  return (
    <div className="ab-section-head">
      <div className="ab-eyebrow">{eyebrow}</div>
      <h2 className="ab-h2">{title}</h2>
      {sub && <p className="ab-lead" style={{ margin: '12px auto 0' }}>{sub}</p>}
    </div>
  );
}

export function BarChart({ data, field, color }: { data: { day: string; requests: number; tokens: number }[]; field: 'requests' | 'tokens'; color?: string }) {
  const max = Math.max(1, ...data.map(d => Number(d[field] ?? 0)));
  if (!data.length) return <Empty>No usage data yet.</Empty>;
  return (
    <div>
      <div className="ab-chart">
        {data.slice(-30).map((d, i) => (
          <div
            key={`${d.day}-${i}`} className="ab-bar" title={`${d.day}: ${d[field]}`}
            style={{ height: `${Math.max(3, (Number(d[field]) / max) * 100)}%`, background: color }}
          />
        ))}
      </div>
      <div className="ab-row" style={{ justifyContent: 'space-between', marginTop: 8, fontSize: 11 }}>
        <span className="ab-muted">{data[0]?.day}</span>
        <span className="ab-muted">{data[data.length - 1]?.day}</span>
      </div>
    </div>
  );
}
