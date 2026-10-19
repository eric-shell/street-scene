/**
 * Garage UI: side panel with live-preview categories. Body part menus are
 * populated entirely from partsCatalog.json. Builds save to localStorage
 * slots and export as share codes. Hidden dev mode (Ctrl+Shift+D or ?dev)
 * accepts a dropped GLB and equips it live in a chosen slot.
 */
import type { GameRenderer } from '../render/scene';
import { CarAssetLibrary, MANIFEST, manifestCar, partsFor } from '../render/carAssets';
import { GarageScene } from './garageScene';
import { GarageState, MAX_SLOTS, decodeShareCode, encodeShareCode, freshBuild, shareUrl } from './storage';
import { BODY_PART_SLOTS, OPTIONAL_SLOTS, PART_SLOTS, PartSlot, SLOT_LABELS } from '../shared/parts';
import { CarBuild, DecalLayer, GLOW_PATTERNS, MAX_DECALS, PAINT_FINISHES, VINYL_SHAPES, VinylShape, validateBuild } from '../sim/build';
import { PERFORMANCE_CATEGORIES, PerformanceCategory, TIER_NAMES, Tier } from '../sim/tuning';
import { tuningForBuild } from '../sim/build';
import { measureStats, statBars } from '../sim/stats';
import { SHAPE_LABELS } from '../render/decals';
import { btn, h, iconBtn, segmented, toast } from '../ui/dom';
import {
  ArrowUpDown,
  Car,
  Check,
  ChevronLeft,
  Copy,
  Disc3,
  Download,
  Eye,
  FlipHorizontal2,
  Gauge,
  Hammer,
  Layers,
  Lightbulb,
  MousePointerClick,
  Paintbrush,
  Play,
  Plus,
  Save,
  Share2,
  Trash2,
  Upload,
  Wind,
  Wrench,
  Zap,
  Box,
  Timer,
  icon,
  IconNode,
} from '../ui/icons';

type Tab = 'car' | 'body' | 'paint' | 'wheels' | 'vinyl' | 'stance' | 'tint' | 'lights' | 'perf' | 'share';

const TABS: { id: Tab; label: string; icon: IconNode }[] = [
  { id: 'car', label: 'Car', icon: Car },
  { id: 'body', label: 'Body', icon: Hammer },
  { id: 'paint', label: 'Paint', icon: Paintbrush },
  { id: 'wheels', label: 'Wheels', icon: Disc3 },
  { id: 'vinyl', label: 'Vinyls', icon: Layers },
  { id: 'stance', label: 'Stance', icon: ArrowUpDown },
  { id: 'tint', label: 'Tint', icon: Eye },
  { id: 'lights', label: 'Lights', icon: Lightbulb },
  { id: 'perf', label: 'Tune', icon: Gauge },
  { id: 'share', label: 'Save', icon: Share2 },
];

const PERF_ICONS: Record<PerformanceCategory, IconNode> = {
  engine: Wrench,
  turbo: Wind,
  exhaust: Wind,
  transmission: Gauge,
  tires: Disc3,
  suspension: ArrowUpDown,
  brakes: Disc3,
  weight: Box,
  nitrous: Zap,
};

export interface GarageCallbacks {
  onChange(g: GarageState): void;
  onExit(): void;
  onTestDrive(): void;
}

export class GarageScreen {
  private scene: GarageScene;
  private root: HTMLElement;
  private body: HTMLElement;
  private tabBar: HTMLElement;
  private title: HTMLElement;
  private tab: Tab = 'car';
  private saveTimer = 0;
  private selectedDecal = -1;
  private placing: { shape: VinylShape; index: number } | null = null;
  private devMode = new URLSearchParams(location.search).has('dev');
  private abort = new AbortController();
  private pointerDown: { x: number; y: number } | null = null;

  constructor(
    gr: GameRenderer,
    private readonly assets: CarAssetLibrary,
    private readonly uiRoot: HTMLElement,
    private garage: GarageState,
    private readonly availability: Record<string, boolean>,
    private readonly cb: GarageCallbacks,
  ) {
    this.scene = new GarageScene(gr, assets);
    this.title = h('div', { class: 'garage-title title' });
    this.tabBar = h('div', { class: 'garage-tabs', role: 'tablist' });
    this.body = h('div', { class: 'garage-body' });
    this.root = h(
      'div',
      { class: 'garage' },
      h(
        'div',
        { class: 'garage-panel panel' },
        h('div', { class: 'garage-head' }, iconBtn(ChevronLeft, 'Back to menu', () => this.exit(), 'small'), this.title, btn(Play, 'Test drive', () => this.testDrive(), 'small primary')),
        this.tabBar,
        this.body,
      ),
      h('div', { class: 'garage-hint muted' }, 'Drag to rotate · scroll or pinch to zoom'),
    );
    uiRoot.append(this.root);
    for (const t of TABS) {
      const b = h('button', { class: 'garage-tab', type: 'button', role: 'tab', title: t.label, onclick: () => this.setTab(t.id) });
      b.append(icon(t.icon, { size: 18 }), h('span', {}, t.label));
      b.dataset.tab = t.id;
      this.tabBar.append(b);
    }
    this.setTab('car');
    void this.scene.setCar(this.build.carId, this.build.visual);

    // Vinyl placement by clicking on the car (a click, not a drag).
    const o = { signal: this.abort.signal };
    gr.canvas.addEventListener('pointerdown', (e) => (this.pointerDown = { x: e.clientX, y: e.clientY }), o);
    gr.canvas.addEventListener(
      'pointerup',
      (e) => {
        const d = this.pointerDown;
        this.pointerDown = null;
        if (!d || !this.placing || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
        const hit = this.scene.pick(e.clientX, e.clientY);
        if (!hit) return toast('Click on the painted body', MousePointerClick);
        this.placeDecal(hit.pos, hit.normal);
      },
      o,
    );
    // Hidden dev mode: drag and drop a GLB to preview it in a slot.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'KeyD' && e.ctrlKey && e.shiftKey) {
          this.devMode = !this.devMode;
          toast(this.devMode ? 'Dev mode: drop a .glb part onto the window' : 'Dev mode off', Upload);
          this.root.classList.toggle('dev', this.devMode);
        }
      },
      o,
    );
    window.addEventListener('dragover', (e) => this.devMode && e.preventDefault(), o);
    window.addEventListener(
      'drop',
      (e) => {
        if (!this.devMode) return;
        e.preventDefault();
        const file = e.dataTransfer?.files[0];
        if (file && file.name.toLowerCase().endsWith('.glb')) void this.devDrop(file);
        else toast('Drop a .glb file', Upload);
      },
      o,
    );
    this.root.classList.toggle('dev', this.devMode);
  }

  private get build(): CarBuild {
    return this.garage.slots[this.garage.current];
  }

  private setTab(t: Tab): void {
    this.tab = t;
    this.placing = null;
    this.tabBar.querySelectorAll('.garage-tab').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tab === t));
    this.renderTab();
  }

  /** Apply the current build to the preview and save (debounced). */
  private changed(rerender = false): void {
    void this.scene.setCar(this.build.carId, this.build.visual);
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.cb.onChange(this.garage), 250);
    if (rerender) this.renderTab();
    this.title.textContent = this.build.name;
  }

  private renderTab(): void {
    this.title.textContent = this.build.name;
    this.body.replaceChildren();
    const b = this.build;
    const v = b.visual;
    const section = (label: string, ic: IconNode | null, ...children: (Node | false | null)[]) =>
      h('div', { class: 'g-section' }, h('div', { class: 'label' }, ic && icon(ic, { size: 14 }), label), ...children);
    const color = (value: string, onInput: (c: string) => void) => {
      const el = h('input', { type: 'color', value }) as HTMLInputElement;
      el.addEventListener('input', () => onInput(el.value));
      return el;
    };
    const slider = (label: string, value: number, min: number, max: number, step: number, fmt: (x: number) => string, onInput: (x: number) => void) => {
      const out = h('span', { class: 'g-val' }, fmt(value));
      const el = h('input', { type: 'range', min, max, step, value }) as HTMLInputElement;
      el.addEventListener('input', () => {
        const x = Number(el.value);
        out.textContent = fmt(x);
        onInput(x);
      });
      return h('div', { class: 'g-slider' }, h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', {}, label), out), el);
    };
    const choiceList = <T extends string | null>(items: { value: T; label: string; sub?: string }[], current: T, onPick: (x: T) => void) => {
      const list = h('div', { class: 'g-list' });
      for (const it of items) {
        const el = h('button', { type: 'button', class: `g-item${it.value === current ? ' on' : ''}` }, h('span', {}, it.label), it.sub ? h('span', { class: 'muted' }, it.sub) : null);
        el.addEventListener('click', () => {
          list.querySelectorAll('.g-item').forEach((x) => x.classList.remove('on'));
          el.classList.add('on');
          onPick(it.value);
        });
        list.append(el);
      }
      return list;
    };

    switch (this.tab) {
      case 'car': {
        const nameInput = h('input', { type: 'text', value: b.name, maxlength: 24, style: 'width:100%' }) as HTMLInputElement;
        nameInput.addEventListener('input', () => {
          b.name = nameInput.value.slice(0, 24) || 'My Ride';
          this.changed();
        });
        this.body.append(
          section('Build name', null, nameInput),
          section(
            'Car',
            Car,
            choiceList(
              MANIFEST.cars.map((c) => ({ value: c.id, label: c.displayName, sub: this.availability[c.id] ? (c.source === 'placeholder' ? 'Placeholder' : 'IceMaan') : 'Model not imported yet' })),
              b.carId,
              (id) => {
                if (id === b.carId) return;
                b.carId = id;
                // Parts are per car; wheels are universal and stay.
                const wheels = v.parts.wheels;
                v.parts = wheels ? { wheels } : {};
                v.decals = [];
                this.changed();
              },
            ),
          ),
        );
        break;
      }
      case 'body': {
        for (const slot of ['body' as PartSlot, ...BODY_PART_SLOTS]) {
          const parts = partsFor(b.carId, slot);
          const optional = OPTIONAL_SLOTS.includes(slot);
          const items: { value: string | null; label: string; sub?: string }[] = [{ value: null, label: optional ? 'None' : 'Stock' }, ...parts.map((p) => ({ value: p.id, label: p.displayName, sub: `${p.tris} tris` }))];
          const dev = [...this.assets.devParts.entries()].filter(([, d]) => d.slot === slot).map(([id, d]) => ({ value: id, label: d.name, sub: 'Dev preview' }));
          items.push(...dev);
          this.body.append(
            section(
              SLOT_LABELS[slot],
              null,
              items.length > 1
                ? choiceList(items, v.parts[slot] ?? null, (id) => {
                    v.parts[slot] = id;
                    this.changed();
                  })
                : h('div', { class: 'muted g-empty' }, slot === 'body' ? 'Only the stock body for this car.' : 'No parts for this slot yet. See docs/partsAuthoring.md to add one.'),
            ),
          );
        }
        break;
      }
      case 'paint': {
        const presets = ['#d11f3f', '#ff6a00', '#ffcc1f', '#3dff9a', '#19e6ff', '#1f6bff', '#8b3dff', '#ff3df2', '#f2f2f2', '#9aa3ad', '#2a2c33', '#0b0b0d'];
        const sw = h('div', { class: 'g-swatches' });
        const picker = color(v.paint.color, (c) => {
          v.paint.color = c;
          this.changed();
        });
        for (const p of presets) {
          const s = h('button', { type: 'button', class: 'g-swatch', style: `background:${p}`, 'aria-label': p });
          s.addEventListener('click', () => {
            v.paint.color = p;
            picker.value = p;
            this.changed();
          });
          sw.append(s);
        }
        this.body.append(
          section('Body color', Paintbrush, h('div', { class: 'row' }, picker, sw)),
          section(
            'Finish',
            null,
            segmented(
              PAINT_FINISHES.map((f) => ({ value: f, label: f })),
              v.paint.finish,
              (f) => {
                v.paint.finish = f;
                this.changed();
              },
            ),
          ),
          section(
            'Trim color',
            null,
            color(v.trimColor, (c) => {
              v.trimColor = c;
              this.changed();
            }),
          ),
        );
        break;
      }
      case 'wheels': {
        const wheels = partsFor(b.carId, 'wheels');
        this.body.append(
          section(
            'Rims',
            Disc3,
            choiceList(
              wheels.map((p) => ({ value: p.id, label: p.displayName, sub: `${p.tris} tris` })),
              v.parts.wheels ?? manifestCar(b.carId).defaultWheel,
              (id) => {
                v.parts.wheels = id;
                this.changed();
              },
            ),
          ),
          section(
            'Rim size',
            null,
            slider('Size', v.wheels.size, 0.85, 1.25, 0.01, (x) => `${Math.round(x * 100)}%`, (x) => {
              v.wheels.size = x;
              this.changed();
            }),
          ),
          section(
            'Rim color',
            null,
            color(v.wheels.color, (c) => {
              v.wheels.color = c;
              this.changed();
            }),
          ),
        );
        break;
      }
      case 'vinyl':
        this.renderVinyls(section, color, slider);
        break;
      case 'stance': {
        const s = v.stance;
        const cm = (x: number) => `${Math.round(x * 100)} cm`;
        this.body.append(
          section(
            'Stance (visual only)',
            ArrowUpDown,
            slider('Ride height', s.rideHeight, -0.08, 0.06, 0.005, cm, (x) => {
              s.rideHeight = x;
              this.changed();
            }),
            slider('Front camber', s.camberFront, -10, 2, 0.5, (x) => `${x}°`, (x) => {
              s.camberFront = x;
              this.changed();
            }),
            slider('Rear camber', s.camberRear, -10, 2, 0.5, (x) => `${x}°`, (x) => {
              s.camberRear = x;
              this.changed();
            }),
            slider('Wheel offset', s.offset, -0.03, 0.08, 0.005, cm, (x) => {
              s.offset = x;
              this.changed();
            }),
          ),
        );
        break;
      }
      case 'tint': {
        this.body.append(
          section(
            'Window tint',
            Eye,
            slider('Darkness', v.tint.darkness, 0, 0.95, 0.01, (x) => `${Math.round(x * 100)}%`, (x) => {
              v.tint.darkness = x;
              this.changed();
            }),
            h(
              'div',
              { class: 'row' },
              h('span', {}, 'Tint color'),
              color(v.tint.color, (c) => {
                v.tint.color = c;
                this.changed();
              }),
            ),
          ),
        );
        break;
      }
      case 'lights': {
        const g = v.underglow;
        this.body.append(
          section(
            'Underglow',
            Lightbulb,
            segmented(
              [
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ],
              g.enabled ? 'on' : 'off',
              (x) => {
                g.enabled = x === 'on';
                this.changed();
              },
            ),
            h(
              'div',
              { class: 'row' },
              h('span', {}, 'Color'),
              color(g.color, (c) => {
                g.color = c;
                this.changed();
              }),
            ),
            segmented(
              GLOW_PATTERNS.map((p) => ({ value: p, label: p })),
              g.pattern,
              (p) => {
                g.pattern = p;
                this.changed();
              },
            ),
          ),
          section(
            'Headlights',
            null,
            color(v.headlightColor, (c) => {
              v.headlightColor = c;
              this.changed();
            }),
          ),
          section(
            'Taillights',
            null,
            color(v.taillightColor, (c) => {
              v.taillightColor = c;
              this.changed();
            }),
          ),
        );
        break;
      }
      case 'perf':
        this.renderPerformance(section);
        break;
      case 'share':
        this.renderShare(section);
        break;
    }
  }

  private renderVinyls(
    section: (label: string, ic: IconNode | null, ...c: (Node | false | null)[]) => HTMLElement,
    color: (v: string, f: (c: string) => void) => HTMLInputElement,
    slider: (l: string, v: number, a: number, b: number, s: number, f: (x: number) => string, i: (x: number) => void) => HTMLElement,
  ): void {
    const v = this.build.visual;
    const full = v.decals.length >= MAX_DECALS;
    const shapes = h('div', { class: 'g-grid' });
    for (const shape of VINYL_SHAPES) {
      const b = h('button', { type: 'button', class: `g-item${this.placing?.shape === shape ? ' on' : ''}` }, SHAPE_LABELS[shape]);
      if (full) b.setAttribute('disabled', '');
      b.addEventListener('click', () => {
        this.placing = { shape, index: -1 };
        this.renderTab();
        toast('Click on the car to place the vinyl', MousePointerClick);
      });
      shapes.append(b);
    }
    this.body.append(section(`Add vinyl (${v.decals.length}/${MAX_DECALS})`, Plus, shapes, this.placing ? h('div', { class: 'g-note' }, icon(MousePointerClick, { size: 14 }), 'Click on the painted body to place it') : null));
    if (!v.decals.length) return;
    const layers = h('div', { class: 'g-list' });
    v.decals.forEach((d, i) => {
      const el = h('button', { type: 'button', class: `g-item${i === this.selectedDecal ? ' on' : ''}` }, h('span', {}, `${i + 1}. ${SHAPE_LABELS[d.shape]}`), h('span', { class: 'g-dot', style: `background:${d.color}` }));
      el.addEventListener('click', () => {
        this.selectedDecal = i;
        this.renderTab();
      });
      layers.append(el);
    });
    this.body.append(section('Layers', Layers, layers));
    const d = v.decals[this.selectedDecal];
    if (!d) return;
    const update = () => this.changed();
    this.body.append(
      section(
        'Selected layer',
        null,
        h(
          'div',
          { class: 'row' },
          color(d.color, (c) => {
            d.color = c;
            update();
          }),
          btn(FlipHorizontal2, d.mirror ? 'Mirrored' : 'Mirror', () => {
            d.mirror = !d.mirror;
            update();
            this.renderTab();
          }, `small${d.mirror ? ' primary' : ''}`),
          btn(MousePointerClick, 'Move', () => {
            this.placing = { shape: d.shape, index: this.selectedDecal };
            toast('Click on the car to move the vinyl', MousePointerClick);
          }, 'small'),
          iconBtn(Trash2, 'Delete layer', () => {
            v.decals.splice(this.selectedDecal, 1);
            this.selectedDecal = -1;
            this.changed(true);
          }, 'small'),
        ),
        slider('Scale', d.scale, 0.2, 3, 0.05, (x) => `${x.toFixed(2)} m`, (x) => {
          d.scale = x;
          update();
        }),
        slider('Rotation', d.rotation, -180, 180, 1, (x) => `${x}°`, (x) => {
          d.rotation = x;
          update();
        }),
        d.shape === 'number' &&
          (() => {
            const t = h('input', { type: 'text', value: d.text ?? '7', maxlength: 2, inputmode: 'numeric', style: 'width:70px' }) as HTMLInputElement;
            t.addEventListener('input', () => {
              d.text = t.value.replace(/[^0-9]/g, '').slice(0, 2) || '7';
              update();
            });
            return h('div', { class: 'row' }, h('span', {}, 'Number'), t);
          })(),
      ),
    );
  }

  private placeDecal(pos: [number, number, number], normal: [number, number, number]): void {
    const v = this.build.visual;
    const p = this.placing!;
    if (p.index >= 0 && v.decals[p.index]) {
      v.decals[p.index].pos = pos;
      v.decals[p.index].normal = normal;
    } else {
      if (v.decals.length >= MAX_DECALS) return;
      const layer: DecalLayer = { shape: p.shape, color: '#ffffff', pos, normal, rotation: 0, scale: p.shape === 'stripe' || p.shape === 'twinStripe' ? 1.6 : 0.8, mirror: Math.abs(normal[0]) > 0.6, text: p.shape === 'number' ? '7' : undefined };
      v.decals.push(layer);
      this.selectedDecal = v.decals.length - 1;
    }
    this.placing = null;
    this.changed(true);
  }

  private renderPerformance(section: (label: string, ic: IconNode | null, ...c: (Node | false | null)[]) => HTMLElement): void {
    const b = this.build;
    const stats = measureStats(tuningForBuild(b.carId, b.performance));
    const bars = statBars(stats);
    const bar = (label: string, value: number, text: string, ic: IconNode) =>
      h('div', { class: 'g-stat' }, h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: 'label' }, icon(ic, { size: 14 }), label), h('span', { class: 'g-val' }, text)), h('div', { class: 'g-bar' }, h('div', { class: 'fill', style: `width:${value * 100}%` })));
    this.body.append(
      section(
        'Stats',
        Gauge,
        bar('Top speed', bars.topSpeed, `${Math.round(stats.topSpeed)} km/h`, Gauge),
        bar('Acceleration', bars.acceleration, `0-100 ${stats.zeroTo100.toFixed(2)} s`, Timer),
        bar('Handling', bars.handling, `${stats.grip.toFixed(2)} g`, Disc3),
        bar('Nitrous', bars.nitrous, `${stats.nitrous.toFixed(1)} kN·s`, Zap),
      ),
    );
    for (const cat of PERFORMANCE_CATEGORIES) {
      this.body.append(
        section(
          cat,
          PERF_ICONS[cat],
          segmented(
            TIER_NAMES.map((n, i) => ({ value: String(i), label: n })),
            String(b.performance[cat]),
            (x) => {
              b.performance[cat] = Number(x) as Tier;
              this.changed(true);
            },
          ),
        ),
      );
    }
    this.body.append(h('div', { class: 'muted g-note' }, 'Everything is unlocked in this proof of concept. Visual parts never change performance.'));
  }

  private renderShare(section: (label: string, ic: IconNode | null, ...c: (Node | false | null)[]) => HTMLElement): void {
    const g = this.garage;
    const list = h('div', { class: 'g-list' });
    g.slots.forEach((s, i) => {
      const el = h('div', { class: `g-item${i === g.current ? ' on' : ''}` }, h('span', {}, `${s.name}`), h('span', { class: 'muted' }, manifestCar(s.carId).displayName));
      el.addEventListener('click', () => {
        g.current = i;
        this.changed(true);
      });
      list.append(el);
    });
    const slotActions = h(
      'div',
      { class: 'row' },
      btn(Plus, 'New', () => {
        if (g.slots.length >= MAX_SLOTS) return toast(`Up to ${MAX_SLOTS} builds`, Save);
        g.slots.push(freshBuild('proto', `Build ${g.slots.length + 1}`));
        g.current = g.slots.length - 1;
        this.changed(true);
      }, 'small'),
      btn(Copy, 'Duplicate', () => {
        if (g.slots.length >= MAX_SLOTS) return toast(`Up to ${MAX_SLOTS} builds`, Save);
        const copy = validateBuild(JSON.parse(JSON.stringify(this.build)));
        copy.name = `${copy.name} copy`.slice(0, 24);
        g.slots.push(copy);
        g.current = g.slots.length - 1;
        this.changed(true);
      }, 'small'),
      btn(Trash2, 'Delete', () => {
        if (g.slots.length <= 1) return toast('Keep at least one build', Save);
        g.slots.splice(g.current, 1);
        g.current = Math.max(0, g.current - 1);
        this.changed(true);
      }, 'small'),
    );
    const codeOut = h('input', { type: 'text', readonly: true, placeholder: 'Press Export to create a code', style: 'width:100%' }) as HTMLInputElement;
    const importIn = h('input', { type: 'text', placeholder: 'Paste a build code or link', style: 'width:100%' }) as HTMLInputElement;
    this.body.append(
      section('Garage slots', Save, list, slotActions, h('div', { class: 'muted g-note' }, 'Builds save automatically in this browser.')),
      section(
        'Share',
        Share2,
        codeOut,
        h(
          'div',
          { class: 'row' },
          btn(Download, 'Export', async () => {
            codeOut.value = await encodeShareCode(this.build);
          }, 'small primary'),
          btn(Copy, 'Copy link', async () => {
            const code = codeOut.value || (await encodeShareCode(this.build));
            codeOut.value = code;
            try {
              await navigator.clipboard.writeText(shareUrl(code));
              toast('Share link copied', Check);
            } catch {
              codeOut.select();
              toast('Copy the code from the box', Copy);
            }
          }, 'small'),
        ),
      ),
      section(
        'Import',
        Upload,
        importIn,
        btn(Upload, 'Load code', async () => {
          let code = importIn.value.trim();
          try {
            const u = new URL(code);
            code = u.searchParams.get('build') ?? code;
          } catch {
            /* plain code */
          }
          const imported = await decodeShareCode(code);
          if (!imported) return toast('That code could not be read', Upload);
          if (g.slots.length >= MAX_SLOTS) g.slots.splice(g.current, 1, imported);
          else g.slots.push(imported);
          g.current = g.slots.indexOf(imported);
          this.changed(true);
          toast(`Loaded "${imported.name}"`, Check);
        }, 'small'),
      ),
    );
  }

  private async devDrop(file: File): Promise<void> {
    let object;
    try {
      object = await this.assets.parseDropped(await file.arrayBuffer());
    } catch (e) {
      toast(`Could not read ${file.name}`, Upload);
      console.error(e);
      return;
    }
    const names = this.scene.car?.baseMeshNames() ?? [];
    const guess = (PART_SLOTS as readonly string[]).find((s) => file.name.includes(`_${s}_`)) as PartSlot | undefined;
    const dialog = h('div', { class: 'screen center dim' });
    const slotSel = h('select', {}, ...PART_SLOTS.filter((s) => s !== 'body').map((s) => h('option', { value: s, selected: s === guess }, SLOT_LABELS[s]))) as HTMLSelectElement;
    const hideBoxes = names.map((n) => {
      const cb = h('input', { type: 'checkbox', value: n }) as HTMLInputElement;
      return h('label', { class: 'row', style: 'gap:6px;font-size:14px' }, cb, n);
    });
    dialog.append(
      h(
        'div',
        { class: 'dialog panel' },
        h('h2', { class: 'title' }, icon(Upload, { size: 22 }), 'Preview part'),
        h('div', { class: 'muted' }, file.name),
        h('div', { class: 'setting-row' }, h('span', { class: 'label' }, 'Slot'), slotSel),
        names.length ? h('div', { class: 'label' }, 'Hide base meshes') : null,
        h('div', { class: 'col', style: 'max-height:200px;overflow:auto' }, ...hideBoxes),
        h(
          'div',
          { class: 'row' },
          btn(Check, 'Equip', () => {
            const slot = slotSel.value as PartSlot;
            const id = `dev_${Date.now().toString(36)}`;
            this.assets.devParts.set(id, { slot, object, name: file.name.replace(/\.glb$/i, '') });
            const v = this.build.visual;
            v.parts[slot] = id;
            const hides = hideBoxes.map((l) => l.querySelector('input') as HTMLInputElement).filter((c) => c.checked).map((c) => c.value);
            void this.scene.setCar(this.build.carId, v).then((view) => view.setDevHides(slot, hides));
            dialog.remove();
            this.setTab(slot === 'wheels' ? 'wheels' : 'body');
            toast('Dev part equipped (not saved to the catalog)', Check);
          }, 'primary'),
          btn(Trash2, 'Cancel', () => dialog.remove()),
        ),
      ),
    );
    this.uiRoot.append(dialog);
  }

  private exit(): void {
    this.cb.onChange(this.garage);
    this.cb.onExit();
  }

  private testDrive(): void {
    this.cb.onChange(this.garage);
    this.cb.onTestDrive();
  }

  tick(): void {}

  render(dt: number): void {
    this.scene.render(dt);
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    this.cb.onChange(this.garage);
    this.abort.abort();
    this.root.remove();
    this.scene.dispose();
  }
}
