/**
 * Camera tuning panel. Live sliders for every number in the CAMERA table
 * (chase/close/bumper/hood follow and FOV, shake and wall handling, plus the
 * start and finish cinematic timing), grouped by section, with a tooltip per
 * parameter, JSON export (copy / download), import and reset. Tweaks persist
 * in localStorage and are applied at boot. Shown in races and free roam when
 * the "Debug mode" setting is on, and toggled there with F3. Same look and
 * classes as the physics tuning panel.
 */
import { CAMERA, CAMERA_DEFAULTS, CAMERA_PARAM_META } from '../../render/camera/camera';
import { btn, h, iconBtn, toast } from '../kit/dom';
import { Camera, Check, Copy, Download, RotateCcw, Upload, X, icon } from '../kit/icons';

const KEY = 'nightrun.cameraParams.v1';

const getAt = (obj: unknown, path: string): number => path.split('.').reduce((o, k) => (o as Record<string, unknown>)?.[k], obj) as number;
function setAt(obj: unknown, path: string, v: number): void {
  const keys = path.split('.');
  let o = obj as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] as Record<string, unknown>;
  o[keys[keys.length - 1]] = v;
}

/** Every numeric camera parameter path, in table order. */
function cameraPaths(): string[] {
  const out: string[] = [];
  for (const [sec, group] of Object.entries(CAMERA_DEFAULTS)) for (const [k, v] of Object.entries(group)) if (typeof v === 'number') out.push(`${sec}.${k}`);
  return out;
}

/** Values that differ from the defaults, as a flat "section.key": value map. */
function changedValues(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of cameraPaths()) if (Math.abs(getAt(CAMERA, p) - getAt(CAMERA_DEFAULTS, p)) > 1e-9) out[p] = getAt(CAMERA, p);
  return out;
}

/** Apply a flat path map (or a nested params object) onto CAMERA. Returns how many values were applied. */
function applyValues(values: unknown): number {
  let n = 0;
  const flat: Record<string, unknown> = {};
  if (values && typeof values === 'object') {
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) flat[`${k}.${k2}`] = v2;
      else flat[k] = v;
    }
  }
  for (const p of cameraPaths()) {
    const v = flat[p];
    if (typeof v === 'number' && Number.isFinite(v)) {
      setAt(CAMERA, p, v);
      n++;
    }
  }
  return n;
}

function persist(): void {
  try {
    const c = changedValues();
    if (Object.keys(c).length) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Re-apply saved camera tweaks at boot. */
export function applySavedCameraParams(): number {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? applyValues(JSON.parse(raw)) : 0;
  } catch {
    return 0;
  }
}

const SECTION_NAMES: Record<string, string> = {
  chase: 'chase camera',
  close: 'close chase',
  bumper: 'bumper camera',
  hood: 'hood camera',
  common: 'shake, walls, FOV',
  intro: 'start cinematic',
  outro: 'finish cinematic',
};

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(3));

export class CameraPanel {
  private root: HTMLElement | null = null;

  constructor(private readonly parent: HTMLElement) {}

  get open(): boolean {
    return !!this.root;
  }

  toggle(): void {
    if (this.root) this.close();
    else this.show();
  }

  show(): void {
    this.close();
    const exportJson = () => JSON.stringify({ nightRunCamera: 1, changed: changedValues(), params: CAMERA }, null, 2);
    const search = h('input', { type: 'text', placeholder: 'Filter parameters', 'aria-label': 'Filter camera parameters', style: 'width:100%' }) as HTMLInputElement;
    const list = h('div', { class: 'tuning-panel__list' });
    const sections = new Map<string, HTMLElement>();
    const rows: { text: string; el: HTMLElement; sync: () => void }[] = [];

    for (const path of cameraPaths()) {
      const [sec, key] = path.split('.');
      let body = sections.get(sec);
      if (!body) {
        body = h('div', { class: 'tuning-panel__section-body' });
        list.append(h('details', { class: 'tuning-panel__section', open: sec === 'chase' || sec === 'outro' }, h('summary', { class: 'tuning-panel__section-title' }, SECTION_NAMES[sec] ?? sec), body));
        sections.set(sec, body);
      }
      const [min, max, step, tip] = CAMERA_PARAM_META[path] ?? [0, Math.max(1, getAt(CAMERA_DEFAULTS, path) * 3), 0.01, path];
      const val = getAt(CAMERA, path);
      const out = h('span', { class: 'tuning-panel__value' }, fmt(val));
      const input = h('input', { class: 'tuning-panel__slider', type: 'range', min: Math.min(min, val), max: Math.max(max, val), step, value: val, 'aria-label': path, title: tip }) as HTMLInputElement;
      const row = h('div', { class: 'tuning-panel__row' });
      const sync = () => {
        const v = getAt(CAMERA, path);
        input.value = String(v);
        out.textContent = fmt(v);
        row.classList.toggle('is-changed', Math.abs(v - getAt(CAMERA_DEFAULTS, path)) > 1e-9);
      };
      input.addEventListener('input', () => {
        setAt(CAMERA, path, Number(input.value));
        sync();
      });
      // Give the keyboard back to driving as soon as the slider is released.
      input.addEventListener('change', () => {
        persist();
        input.blur();
      });
      const reset = iconBtn(
        RotateCcw,
        `Reset ${path}`,
        () => {
          setAt(CAMERA, path, getAt(CAMERA_DEFAULTS, path));
          sync();
          persist();
        },
        '--small tuning-panel__reset',
      );
      // Hover shows the title; a tap or click on the name shows it inline (touch friendly).
      const tipEl = h('div', { class: 'muted tuning-panel__tip', style: 'grid-column:1 / span 3;font-size:11px;line-height:1.35;display:none' }, tip);
      const label = h('label', { class: 'tuning-panel__label', title: tip, style: 'cursor:help' }, key);
      label.addEventListener('click', () => (tipEl.style.display = tipEl.style.display === 'none' ? '' : 'none'));
      row.append(label, out, reset, tipEl, input);
      sync();
      body.append(row);
      rows.push({ text: `${path} ${tip}`.toLowerCase(), el: row, sync });
    }
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      for (const r of rows) r.el.style.display = !q || r.text.includes(q) ? '' : 'none';
      if (q) list.querySelectorAll('details').forEach((d) => ((d as HTMLDetailsElement).open = true));
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());

    const importBox = () => {
      const area = h('textarea', { rows: 6, placeholder: 'Paste exported camera JSON or a "section.key": value map', style: 'width:100%;font:12px monospace' }) as HTMLTextAreaElement;
      area.addEventListener('keydown', (e) => e.stopPropagation());
      const wrap = h('div', { class: 'col' }, area);
      wrap.append(
        btn(Check, 'Apply', () => {
          try {
            const obj = JSON.parse(area.value) as { changed?: unknown; params?: unknown };
            const n = applyValues(obj.changed ?? obj.params ?? obj);
            rows.forEach((r) => r.sync());
            persist();
            toast(`Applied ${n} values`, Check);
            wrap.remove();
          } catch {
            toast('That is not valid camera JSON', Upload);
          }
        }, '--small --primary'),
      );
      list.before(wrap);
    };

    this.root = h(
      'div',
      // Left side, so it can sit next to the physics panel.
      { class: 'tuning-panel tuning-panel--camera panel', style: 'left:max(10px, env(safe-area-inset-left));right:auto' },
      h('div', { class: 'tuning-panel__head' }, h('div', { class: 'label' }, icon(Camera, { size: 14 }), 'Camera tuning'), iconBtn(X, 'Close camera tuning', () => this.close(), '--small')),
      search,
      h(
        'div',
        { class: 'row', style: 'gap:6px' },
        btn(Copy, 'Copy JSON', async () => {
          try {
            await navigator.clipboard.writeText(exportJson());
            toast('Camera JSON copied', Check);
          } catch {
            toast('Clipboard blocked: use Download', Copy);
          }
        }, '--small'),
        btn(Download, 'Download', () => {
          const blob = new Blob([exportJson()], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: 'nightrun-camera.json' });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }, '--small'),
        btn(Upload, 'Import', importBox, '--small'),
        btn(RotateCcw, 'Reset all', () => {
          applyValues(CAMERA_DEFAULTS);
          rows.forEach((r) => r.sync());
          persist();
        }, '--small'),
      ),
      h(
        'div',
        { class: 'muted tuning-panel__note' },
        'Changes apply live and are kept on this device. Start cinematic framing is read when a race starts. Tap a name for its description. The export has a "changed" list to paste into CAMERA_DEFAULTS in src/render/camera/camera.ts.',
      ),
      list,
    );
    this.parent.append(this.root);
  }

  close(): void {
    this.root?.remove();
    this.root = null;
  }
}
