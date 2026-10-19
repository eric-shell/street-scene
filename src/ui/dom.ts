/** Tiny DOM helpers for the plain-DOM UI. */
import { icon, IconNode } from './icons';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Button with a Lucide icon and label. */
export function btn(iconNode: IconNode | null, label: string, onClick: () => void, cls = '', sub?: string): HTMLButtonElement {
  const b = h('button', { class: `btn ${cls}`.trim(), type: 'button', onclick: onClick });
  if (iconNode) b.append(icon(iconNode, { size: 18 }));
  const text = h('span', { class: 'grow' }, label);
  if (sub) text.append(h('span', { class: 'sub' }, sub));
  b.append(text);
  return b;
}

export function iconBtn(iconNode: IconNode, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `btn icon-only ${cls}`.trim(), type: 'button', title: label, 'aria-label': label, onclick: onClick });
  b.append(icon(iconNode, { size: 18 }));
  return b;
}

export function segmented<T extends string>(options: { value: T; label: string; icon?: IconNode }[], value: T, onChange: (v: T) => void): HTMLDivElement {
  const wrap = h('div', { class: 'seg', role: 'radiogroup' });
  const buttons = options.map((o) => {
    const b = h('button', { type: 'button', role: 'radio' });
    if (o.icon) b.append(icon(o.icon, { size: 15 }));
    b.append(o.label);
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onChange(o.value);
    });
    if (o.value === value) b.classList.add('on');
    wrap.append(b);
    return b;
  });
  return wrap;
}

export function toast(text: string, iconNode?: IconNode): void {
  const t = h('div', { class: 'toast panel' });
  if (iconNode) t.append(icon(iconNode, { size: 16 }));
  t.append(text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2700);
}
