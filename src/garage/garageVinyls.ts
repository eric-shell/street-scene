/**
 * The Vinyls tab: the shapes to add, the build's layers and the selected
 * layer's color, mirror, scale, rotation and number, plus placing a layer where
 * the player clicks on the car (the screen routes the click to placeDecal).
 * Like the other tabs it reaches the screen through TabHost.
 */
import { DecalLayer, MAX_DECALS, VINYL_SHAPES } from '../shared/carBuild';
import { SHAPE_LABELS } from '../render/car/decals';
import { btn, h, iconBtn, sheen, toast } from '../ui/kit/dom';
import { M_PER_FT } from '../ui/kit/units';
import { FlipHorizontal2, MousePointerClick, Trash2, icon } from '../ui/kit/icons';
import type { TabHost } from './garageTabs';
import { choiceList, colorPicker, revealable, section, slider, toggle } from './garageWidgets';

/** Fill the body with the shapes to add, then the layers and the selected layer's controls. */
export function renderVinyls(host: TabHost): void {
  const v = host.build.visual;
  const full = v.decals.length >= MAX_DECALS;
  const shapes = h('div', { class: 'garage-grid' });
  for (const shape of VINYL_SHAPES) {
    const b = h('button', { type: 'button', class: `garage-item${host.placing?.shape === shape ? ' is-selected' : ''}` }, SHAPE_LABELS[shape], sheen());
    if (full) b.setAttribute('disabled', '');
    b.addEventListener('click', () => {
      host.placing = { shape, index: -1 };
      host.renderTab();
      toast('Click on the car to place the vinyl', MousePointerClick);
    });
    shapes.append(b);
  }
  host.body.append(section(`Add vinyl (${v.decals.length}/${MAX_DECALS})`, shapes, host.placing ? revealable(h('div', { class: 'garage-note' }, icon(MousePointerClick, { size: 14 }), 'Click on the painted body to place it'), 'placing') : null));
  if (!v.decals.length) return;
  const layers = choiceList(
    v.decals.map((d, i) => ({ value: i, label: `${i + 1}. ${SHAPE_LABELS[d.shape]}`, extra: h('span', { class: 'garage-dot', style: `background:${d.color}` }) })),
    host.selectedDecal,
    (i) => {
      host.selectedDecal = i;
      host.renderTab();
    },
  );
  host.body.append(section('Layers', layers));
  const d = v.decals[host.selectedDecal];
  if (!d) return;
  const update = () => host.changed();
  host.body.append(
    section(
      'Selected layer',
      h(
        'div',
        { class: 'row' },
        toggle(FlipHorizontal2, 'Mirror', d.mirror, d.mirror ? 'Mirrored to the other side' : 'Mirror to the other side', () => {
          d.mirror = !d.mirror;
          update();
          host.renderTab();
        }),
        btn(MousePointerClick, 'Move', () => {
          host.placing = { shape: d.shape, index: host.selectedDecal };
          toast('Click on the car to move the vinyl', MousePointerClick);
        }, '--small'),
        iconBtn(Trash2, 'Delete layer', () => {
          v.decals.splice(host.selectedDecal, 1);
          host.selectedDecal = -1;
          host.changed(true);
        }, '--small'),
      ),
      colorPicker(d.color, (c) => {
        d.color = c;
        update();
      }),
      slider('Scale', d.scale, 0.2, 3, 0.05, (x) => `${(x / M_PER_FT).toFixed(1)} ft`, (x) => {
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

/** Put the layer being placed (or moved) where the click hit the car, then refit the car. */
export function placeDecal(host: TabHost, pos: [number, number, number], normal: [number, number, number]): void {
  const v = host.build.visual;
  const p = host.placing!;
  if (p.index >= 0 && v.decals[p.index]) {
    v.decals[p.index].pos = pos;
    v.decals[p.index].normal = normal;
  } else {
    if (v.decals.length >= MAX_DECALS) return;
    const layer: DecalLayer = { shape: p.shape, color: '#ffffff', pos, normal, rotation: 0, scale: p.shape === 'stripe' || p.shape === 'twinStripe' ? 1.6 : 0.8, mirror: Math.abs(normal[0]) > 0.6, text: p.shape === 'number' ? '7' : undefined };
    v.decals.push(layer);
    host.selectedDecal = v.decals.length - 1;
  }
  host.placing = null;
  host.changed(true);
}
