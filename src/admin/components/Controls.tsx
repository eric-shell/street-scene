/**
 * The game's kit controls as React: the chamfered button with its sheen (ui/kit/dom.ts btn, iconBtn), the
 * segmented control (segmented) and the tabs, rendering the kit's exact BEM markup so ui/kit's partials style
 * them as they do in the game. Segments and tabs are one value chosen from a set: one tab stop, arrows move.
 */
import type { IconNode } from 'lucide';
import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from './Icon';

/** `cls`: kit modifiers (`--primary`, `--small`, `--ghost`) and extra classes, as the kit's `bem` takes them. */
function bem(block: string, extra = ''): string {
  return [block, ...extra.split(/\s+/).filter(Boolean).map((w) => (w.startsWith('--') ? block + w : w))].join(' ');
}

export function Button({ icon, children, onClick, cls = '', disabled, title, label, type = 'button' }: { icon?: IconNode; children?: ReactNode; onClick?: () => void; cls?: string; disabled?: boolean; title?: string; label?: string; type?: 'button' | 'submit' }) {
  return (
    <button type={type} className={bem('btn', `${children === undefined ? '--icon ' : ''}${cls}`)} onClick={onClick} disabled={disabled} title={title ?? label} aria-label={label}>
      {icon ? <Icon node={icon} size={children === undefined ? 18 : 16} /> : null}
      {children !== undefined ? <span className="btn__label">{children}</span> : null}
      <span className="sheen" aria-hidden="true" />
    </button>
  );
}

/** Arrow keys step through a radio-like group and focus follows the selection. */
function stepKeys<T extends string>(e: KeyboardEvent<HTMLElement>, values: readonly T[], value: T, onChange: (v: T) => void, attr: string): void {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const next = values[(values.indexOf(value) + step + values.length) % values.length];
  onChange(next);
  e.currentTarget.parentElement?.querySelector<HTMLElement>(`[${attr}="${next}"]`)?.focus();
}

export function Segmented<T extends string>({ options, value, onChange, labelledBy, label }: { options: readonly { value: T; label: string; title?: string }[]; value: T; onChange: (v: T) => void; labelledBy?: string; label?: string }) {
  const values = options.map((o) => o.value);
  return (
    <div className="segmented" role="radiogroup" aria-labelledby={labelledBy} aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          data-value={o.value}
          title={o.title}
          className={o.value === value ? 'segmented__option is-selected' : 'segmented__option'}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => stepKeys(e, values, value, onChange, 'data-value')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: readonly { value: T; label: string; icon?: IconNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  const values = tabs.map((t) => t.value);
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          data-tab={t.value}
          className={t.value === value ? 'tabs__tab is-selected' : 'tabs__tab'}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => stepKeys(e, values, value, onChange, 'data-tab')}
        >
          {t.icon ? <Icon node={t.icon} size={14} /> : null}
          {t.label}
        </button>
      ))}
    </div>
  );
}
