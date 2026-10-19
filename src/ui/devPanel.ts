/**
 * Hidden live tuning panel (toggle with ` or F2). Sliders write straight into
 * the player car's CarTuning object. Any change marks the run as tuned so it
 * is not saved as a best time or ghost. Copy the values into src/sim/tuning.ts
 * to make them permanent.
 */
import { CarTuning, DEV_PANEL_PARAMS, getByPath, setByPath } from '../sim/tuning';
import { btn, h } from './dom';
import { Copy, SlidersHorizontal, X, icon } from './icons';

export class DevPanel {
  private root: HTMLElement | null = null;

  constructor(private readonly parent: HTMLElement) {}

  get open(): boolean {
    return !!this.root;
  }

  toggle(tuning: CarTuning | null, onChange: () => void): void {
    if (this.root) return this.close();
    if (!tuning) return;
    const root = h('div', { class: 'dev-panel panel' }, h('div', { class: 'label', style: 'margin-bottom:8px' }, icon(SlidersHorizontal, { size: 14 }), `Dev tuning: ${tuning.carId}`));
    for (const [path, min, max, step] of DEV_PANEL_PARAMS) {
      const val = getByPath(tuning, path);
      const out = h('span', {}, val.toFixed(3));
      const input = h('input', { type: 'range', min, max, step, value: val }) as HTMLInputElement;
      input.addEventListener('input', () => {
        const v = Number(input.value);
        setByPath(tuning, path, v);
        out.textContent = v.toFixed(3);
        onChange();
      });
      root.append(h('div', { class: 'param' }, h('label', {}, path), out, input));
    }
    root.append(
      h(
        'div',
        { class: 'row' },
        btn(
          Copy,
          'Copy JSON',
          () => {
            const obj: Record<string, number> = {};
            for (const [p] of DEV_PANEL_PARAMS) obj[p] = getByPath(tuning, p);
            void navigator.clipboard?.writeText(JSON.stringify(obj, null, 2));
          },
          'small',
        ),
        btn(X, 'Close', () => this.close(), 'small'),
      ),
    );
    this.parent.append(root);
    this.root = root;
  }

  close(): void {
    this.root?.remove();
    this.root = null;
  }
}
