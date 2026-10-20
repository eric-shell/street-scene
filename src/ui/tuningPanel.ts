/**
 * Physics tuning panel. Exposes every numeric driving parameter of the
 * player's CarTuning as a live slider, grouped by section, with JSON export
 * (copy / download) and import. Changes persist per car and are re-applied
 * on the next test drive. Opened automatically in test drive, or with ` / F2
 * during any race (runs with changed tuning are never saved as records).
 */
import { CarTuning, DEV_PANEL_PARAMS, getBaseTuning, getByPath, setByPath } from '../sim/tuning';
import { PerformanceBuild, applyBuild } from '../sim/build';
import { btn, h, iconBtn, toast } from './dom';
import { Check, Copy, Download, RotateCcw, SlidersHorizontal, Upload, X, icon } from './icons';

export interface TuningParam {
  path: string;
  min: number;
  max: number;
  step: number;
}

const KEY = (carId: string) => `nightrun.testTuning.${carId}`;
const SKIP = new Set(['carId', 'geometry.wheels']);
/** Torque curve rpm points stay fixed; only the torque values are tunable. */
const isCurveRpm = (path: string) => /^engine\.torqueCurve\.\d+\.0$/.test(path);

function niceStep(range: number): number {
  const raw = range / 200;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
}

/** Every numeric leaf in the tuning object, with slider ranges. */
export function tuningParams(t: CarTuning): TuningParam[] {
  const known = new Map(DEV_PANEL_PARAMS.map(([p, a, b, s]) => [p, { min: a, max: b, step: s }]));
  const out: TuningParam[] = [];
  const walk = (o: unknown, path: string) => {
    if (SKIP.has(path)) return;
    if (typeof o === 'number') {
      if (isCurveRpm(path)) return;
      const k = known.get(path);
      if (k) out.push({ path, ...k });
      else {
        const v = o;
        const min = v > 0 ? 0 : v * 3;
        const max = v > 0 ? Math.max(v * 3, v + 1) : v < 0 ? 0 : 1;
        out.push({ path, min, max, step: niceStep(max - min) });
      }
      return;
    }
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${path}.${i}`));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(t, '');
  return out;
}

export function loadSavedTuning(carId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY(carId));
    const obj = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
  } catch {
    return {};
  }
}

function saveTuning(carId: string, changed: Record<string, number>): void {
  try {
    if (Object.keys(changed).length) localStorage.setItem(KEY(carId), JSON.stringify(changed));
    else localStorage.removeItem(KEY(carId));
  } catch {
    /* ignore */
  }
}

/** Apply saved overrides onto a live tuning object. Returns how many were applied. */
export function applySavedTuning(t: CarTuning, overrides: Record<string, number>): number {
  let n = 0;
  for (const [path, v] of Object.entries(overrides)) {
    try {
      if (typeof getByPath(t, path) === 'number') {
        setByPath(t, path, v);
        n++;
      }
    } catch {
      /* unknown path */
    }
  }
  return n;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(3));

export class TuningPanel {
  private root: HTMLElement | null = null;

  constructor(private readonly parent: HTMLElement) {}

  get open(): boolean {
    return !!this.root;
  }

  toggle(tuning: CarTuning, performance: PerformanceBuild, onChange: () => void): void {
    if (this.root) this.close();
    else this.show(tuning, performance, onChange);
  }

  show(tuning: CarTuning, performance: PerformanceBuild, onChange: () => void): void {
    this.close();
    // Baseline = this car with its performance parts, before any manual tuning.
    const base = applyBuild(getBaseTuning(tuning.carId), performance);
    const params = tuningParams(base);
    const changed = (): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const p of params) {
        const v = getByPath(tuning, p.path);
        if (Math.abs(v - getByPath(base, p.path)) > 1e-9) out[p.path] = v;
      }
      return out;
    };
    const persist = () => saveTuning(tuning.carId, changed());
    const exportJson = () =>
      JSON.stringify(
        {
          nightRunTuning: 1,
          carId: tuning.carId,
          performance,
          changed: changed(),
          tuning,
        },
        null,
        2,
      );

    const search = h('input', { type: 'text', placeholder: 'Filter parameters', 'aria-label': 'Filter parameters', style: 'width:100%' }) as HTMLInputElement;
    const list = h('div', { class: 'tp-list' });
    const sections = new Map<string, HTMLElement>();
    const rows: { path: string; el: HTMLElement; sync: () => void }[] = [];
    for (const p of params) {
      const sec = p.path.includes('.') ? p.path.split('.')[0] : 'body';
      let body = sections.get(sec);
      if (!body) {
        body = h('div', { class: 'tp-section-body' });
        const det = h('details', { class: 'tp-section', open: sec === 'tires' || sec === 'drift' || sec === 'steering' }, h('summary', {}, sec), body);
        list.append(det);
        sections.set(sec, body);
      }
      const label = p.path.includes('.') ? p.path.slice(sec.length + 1) : p.path;
      const val = getByPath(tuning, p.path);
      const lo = Math.min(p.min, val);
      const hi = Math.max(p.max, val);
      const out = h('span', { class: 'tp-val' }, fmt(val));
      const input = h('input', { type: 'range', min: lo, max: hi, step: p.step, value: val, 'aria-label': p.path }) as HTMLInputElement;
      const row = h('div', { class: 'tp-row' });
      const sync = () => {
        const v = getByPath(tuning, p.path);
        input.value = String(v);
        out.textContent = fmt(v);
        row.classList.toggle('changed', Math.abs(v - getByPath(base, p.path)) > 1e-9);
      };
      input.addEventListener('input', () => {
        setByPath(tuning, p.path, Number(input.value));
        sync();
        onChange();
      });
      // Give the keyboard back to driving as soon as the slider is released.
      input.addEventListener('change', () => {
        persist();
        input.blur();
      });
      const reset = iconBtn(
        RotateCcw,
        `Reset ${p.path}`,
        () => {
          setByPath(tuning, p.path, getByPath(base, p.path));
          sync();
          persist();
          onChange();
        },
        'small tp-reset',
      );
      row.append(h('label', { title: p.path }, label), out, reset, input);
      sync();
      body.append(row);
      rows.push({ path: p.path, el: row, sync });
    }
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      for (const r of rows) r.el.style.display = !q || r.path.toLowerCase().includes(q) ? '' : 'none';
      if (q) list.querySelectorAll('details').forEach((d) => ((d as HTMLDetailsElement).open = true));
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());

    const importBox = () => {
      const area = h('textarea', { rows: 6, placeholder: 'Paste exported tuning JSON', style: 'width:100%;font:12px monospace' }) as HTMLTextAreaElement;
      const wrap = h('div', { class: 'col' }, area);
      wrap.append(
        btn(Check, 'Apply', () => {
          try {
            const obj = JSON.parse(area.value) as { changed?: Record<string, number> } & Record<string, number>;
            const values = obj.changed ?? obj;
            const n = applySavedTuning(tuning, values);
            rows.forEach((r) => r.sync());
            persist();
            onChange();
            toast(`Applied ${n} values`, Check);
            wrap.remove();
          } catch {
            toast('That is not valid tuning JSON', Upload);
          }
        }, 'small primary'),
      );
      list.before(wrap);
    };

    this.root = h(
      'div',
      { class: 'tuning-panel panel' },
      h('div', { class: 'tp-head' }, h('div', { class: 'label' }, icon(SlidersHorizontal, { size: 14 }), `Physics tuning · ${tuning.carId}`), iconBtn(X, 'Close tuning', () => this.close(), 'small')),
      search,
      h(
        'div',
        { class: 'row', style: 'gap:6px' },
        btn(Copy, 'Copy JSON', async () => {
          try {
            await navigator.clipboard.writeText(exportJson());
            toast('Tuning JSON copied', Check);
          } catch {
            toast('Clipboard blocked: use Download', Copy);
          }
        }, 'small'),
        btn(Download, 'Download', () => {
          const blob = new Blob([exportJson()], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `nightrun-tuning-${tuning.carId}.json` });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }, 'small'),
        btn(Upload, 'Import', importBox, 'small'),
        btn(RotateCcw, 'Reset all', () => {
          for (const p of params) setByPath(tuning, p.path, getByPath(base, p.path));
          rows.forEach((r) => r.sync());
          persist();
          onChange();
        }, 'small'),
      ),
      h('div', { class: 'muted tp-note' }, 'Changes apply live and are kept for this car in test drives. Changed values are highlighted; the export includes a "changed" list plus the full tuning.'),
      list,
    );
    this.parent.append(this.root);
  }

  close(): void {
    this.root?.remove();
    this.root = null;
  }
}
