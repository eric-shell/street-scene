/**
 * Canvas textures for the garage (garage/showroom.ts): stained concrete, grimy
 * block walls, the roof deck, the roller door, worn paint lines, oil stains,
 * diamond plate, the pegboard, drawer fronts, aged posters and the neon signs.
 * Each is drawn once per visit (a few milliseconds in all) from a fixed hash,
 * so the room looks the same every time. Render only.
 */
import * as THREE from 'three';
import { PALETTE } from '../ui/kit/palette';

export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** A small deterministic hash noise in 0..1 for texture speckle and flicker. */
export function noise(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** An irregular blot: overlapping soft discs round (x, y), for oil, water and grime. */
function blot(g: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, alpha: number, seed: number): void {
  for (let k = 0; k < 7; k++) {
    const a = noise(seed + k * 1.7) * Math.PI * 2;
    const d = noise(seed + k * 3.1) * r * 0.6;
    const rr = r * (0.35 + noise(seed + k * 5.3) * 0.5);
    const cx = x + Math.cos(a) * d;
    const cy = y + Math.sin(a) * d;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
    grad.addColorStop(0, `rgba(${rgb},${alpha})`);
    grad.addColorStop(0.6, `rgba(${rgb},${alpha * 0.6})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, rr, 0, Math.PI * 2);
    g.fill();
  }
}

/** A hairline crack: a jittered walk from (x, y). */
function crack(g: CanvasRenderingContext2D, x: number, y: number, len: number, seed: number): void {
  g.beginPath();
  g.moveTo(x, y);
  let a = noise(seed) * Math.PI * 2;
  for (let i = 0; i < len; i++) {
    a += (noise(seed + i * 0.91) - 0.5) * 0.9;
    x += Math.cos(a) * 6;
    y += Math.sin(a) * 6;
    g.lineTo(x, y);
  }
  g.stroke();
}

/**
 * Shop concrete, 8 m square (128 px/m): mottled grey, speckle, saw-cut joints
 * every 4 m, hairline cracks, patched repairs, tire scuffs and oil stains. The
 * second texture is the matching roughness: oil and wet patches are glossier,
 * so the lights pick them out as dull puddles.
 */
export function concreteTextures(): { color: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const S = 1024;
  const stains: [number, number, number][] = [];
  for (let i = 0; i < 11; i++) stains.push([noise(i * 9.1) * S, noise(i * 4.7 + 2) * S, 30 + noise(i * 2.3) * 70]);
  const color = canvasTexture(S, S, (g) => {
    g.fillStyle = '#4a4946';
    g.fillRect(0, 0, S, S);
    // Low frequency mottling: big soft patches lighter and darker.
    for (let i = 0; i < 60; i++) {
      const light = noise(i * 1.9) > 0.5;
      blot(g, noise(i * 3.3) * S, noise(i * 7.1) * S, 80 + noise(i) * 160, light ? '120,118,112' : '20,20,22', 0.1, i * 13);
    }
    for (let i = 0; i < 26000; i++) {
      const n = noise(i * 1.31);
      g.fillStyle = n > 0.66 ? 'rgba(255,255,255,0.06)' : n > 0.33 ? 'rgba(0,0,0,0.13)' : 'rgba(110,100,90,0.08)';
      g.fillRect(noise(i * 2.7) * S, noise(i * 5.3) * S, 1.6, 1.6);
    }
    // A patched repair: a squarer, smoother rectangle of newer concrete.
    g.fillStyle = 'rgba(96,94,90,0.55)';
    g.fillRect(610, 180, 190, 120);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    g.strokeRect(610, 180, 190, 120);
    // Hairline cracks.
    g.strokeStyle = 'rgba(10,10,10,0.5)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) crack(g, noise(i * 6.6) * S, noise(i * 8.8) * S, 18 + Math.floor(noise(i * 2.2) * 30), i * 31);
    // Tire scuffs: long faint dark arcs where cars were pushed and turned.
    g.lineCap = 'round';
    for (let i = 0; i < 14; i++) {
      const cx = noise(i * 5.5) * S;
      const cy = noise(i * 3.9) * S;
      const r = 200 + noise(i * 1.1) * 500;
      const a0 = noise(i * 2.9) * Math.PI * 2;
      g.strokeStyle = `rgba(8,8,8,${0.06 + noise(i * 7.7) * 0.08})`;
      g.lineWidth = 10 + noise(i) * 8;
      g.beginPath();
      g.arc(cx, cy, r, a0, a0 + 0.3 + noise(i * 4.4) * 0.5);
      g.stroke();
    }
    // Oil stains: dark cores with a brown halo.
    stains.forEach(([x, y, r], i) => {
      blot(g, x, y, r * 1.5, '60,45,30', 0.1, i * 41);
      blot(g, x, y, r, '14,12,10', 0.3, i * 17);
    });
    // Saw-cut joints every 4 m.
    g.fillStyle = 'rgba(0,0,0,0.6)';
    for (const p of [0, 512]) {
      g.fillRect(p, 0, 3, S);
      g.fillRect(0, p, S, 3);
    }
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (const p of [3, 515]) {
      g.fillRect(p, 0, 1, S);
      g.fillRect(0, p, S, 1);
    }
  });
  const rough = canvasTexture(
    256,
    256,
    (g) => {
      // Green channel is roughness: bare concrete is matt, the stains are slick.
      g.fillStyle = 'rgb(0,225,0)';
      g.fillRect(0, 0, 256, 256);
      stains.forEach(([x, y, r], i) => blot(g, x / 4, y / 4, r / 4, '0,95,0', 0.7, i * 17));
      for (let i = 0; i < 6; i++) blot(g, noise(i * 12.1) * 256, noise(i * 6.3) * 256, 20 + noise(i) * 26, '0,110,0', 0.5, i * 71);
    },
    false,
  );
  return { color, rough };
}

/**
 * The block wall, 6.4 m wide and the room's full height (so the grime can
 * follow it): painted block, a darker scuffed band to waist height under a
 * worn safety stripe, soot under the roof, rust and water streaks running down,
 * flaking paint and dirt kicked up along the floor.
 */
export function wallTexture(height: number, band: number): THREE.CanvasTexture {
  const W = 1024;
  const H = 960;
  const pxm = H / height;
  const bandPx = H - band * pxm;
  return canvasTexture(W, H, (g) => {
    g.fillStyle = '#2b2a2c';
    g.fillRect(0, 0, W, H);
    // Blocks 0.4 x 0.2 m in running bond.
    const bw = W / 16;
    const bh = 0.2 * pxm;
    for (let row = 0; row * bh < H; row++) {
      const off = row & 1 ? bw / 2 : 0;
      const y = H - (row + 1) * bh;
      const low = y + bh > bandPx;
      for (let col = -1; col < 17; col++) {
        const v = Math.floor(noise(row * 31 + col) * 10);
        g.fillStyle = low ? `rgb(${30 + v},${37 + v},${38 + v})` : `rgb(${58 + v},${57 + v},${55 + v})`;
        g.fillRect(col * bw + off + 2, y + 2, bw - 4, bh - 4);
        g.fillStyle = 'rgba(255,255,255,0.03)';
        g.fillRect(col * bw + off + 2, y + 2, bw - 4, 2);
      }
    }
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = noise(i) > 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.12)';
      g.fillRect(noise(i * 3.1) * W, noise(i * 7.7) * H, 2, 2);
    }
    // Flaking paint on the upper wall: lighter bare block showing through.
    for (let i = 0; i < 14; i++) blot(g, noise(i * 4.1) * W, noise(i * 2.9) * bandPx * 0.9, 18 + noise(i) * 30, '92,88,80', 0.25, i * 23);
    // The safety stripe over the band, worn through in places.
    g.fillStyle = '#b8932f';
    g.fillRect(0, bandPx - 14, W, 12);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = 'rgba(40,38,36,0.75)';
      g.fillRect(noise(i * 6.1) * W, bandPx - 14 + noise(i * 2.2) * 8, 4 + noise(i * 9.9) * 26, 3 + noise(i) * 6);
    }
    // Scuffs and knocks on the band: trolleys, bumpers, boots.
    g.lineCap = 'round';
    for (let i = 0; i < 30; i++) {
      g.strokeStyle = noise(i * 5.1) > 0.5 ? 'rgba(0,0,0,0.3)' : 'rgba(150,150,150,0.12)';
      g.lineWidth = 2 + noise(i) * 4;
      const x = noise(i * 7.3) * W;
      const y = bandPx + 20 + noise(i * 3.7) * (H - bandPx - 40);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 20 + noise(i * 1.3) * 60, y + (noise(i * 8.1) - 0.5) * 10);
      g.stroke();
    }
    // Soot and nicotine under the roof.
    const soot = g.createLinearGradient(0, 0, 0, H * 0.35);
    soot.addColorStop(0, 'rgba(8,7,6,0.75)');
    soot.addColorStop(1, 'rgba(8,7,6,0)');
    g.fillStyle = soot;
    g.fillRect(0, 0, W, H * 0.35);
    // Streaks running down from the roof: water, rust from the purlins.
    for (let i = 0; i < 26; i++) {
      const x = noise(i * 11.3) * W;
      const len = H * (0.2 + noise(i * 2.7) * 0.6);
      const rust = noise(i * 5.9) > 0.6;
      const grad = g.createLinearGradient(0, 0, 0, len);
      const c = rust ? '96,52,24' : '12,11,10';
      grad.addColorStop(0, `rgba(${c},${rust ? 0.5 : 0.45})`);
      grad.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = grad;
      g.fillRect(x, 0, 3 + noise(i) * 9, len);
    }
    // Dirt kicked up along the floor.
    const dirt = g.createLinearGradient(0, H - 0.5 * pxm, 0, H);
    dirt.addColorStop(0, 'rgba(14,12,10,0)');
    dirt.addColorStop(1, 'rgba(14,12,10,0.7)');
    g.fillStyle = dirt;
    g.fillRect(0, H - 0.5 * pxm, W, 0.5 * pxm);
  });
}

/** The roof deck seen from below: corrugated steel, dark with a few rust blooms. 2 m square. */
export function deckTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g) => {
    for (let x = 0; x < 256; x += 16) {
      const grad = g.createLinearGradient(x, 0, x + 16, 0);
      grad.addColorStop(0, '#1d1d20');
      grad.addColorStop(0.5, '#2c2c30');
      grad.addColorStop(1, '#151517');
      g.fillStyle = grad;
      g.fillRect(x, 0, 16, 256);
    }
    for (let i = 0; i < 5; i++) blot(g, noise(i * 3.3) * 256, noise(i * 9.7) * 256, 14 + noise(i) * 20, '70,40,20', 0.35, i * 5);
  });
}

/** A roller door: dented slats, rust weeping from the bottom rail, grime and the hazard band. */
export function doorTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 512, (g) => {
    for (let y = 0; y < 512; y += 12) {
      const grad = g.createLinearGradient(0, y, 0, y + 12);
      grad.addColorStop(0, '#4b5058');
      grad.addColorStop(0.45, '#33373e');
      grad.addColorStop(0.55, '#25282d');
      grad.addColorStop(1, '#3e434b');
      g.fillStyle = grad;
      g.fillRect(0, y, 256, 12);
    }
    // Dents: a dark smudge with a lit lip.
    for (let i = 0; i < 5; i++) {
      const x = 30 + noise(i * 4.4) * 200;
      const y = 300 + noise(i * 2.1) * 170;
      blot(g, x, y, 16, '0,0,0', 0.35, i * 9);
    }
    for (let i = 0; i < 18; i++) {
      const x = noise(i * 7.7) * 256;
      const len = 60 + noise(i * 3.1) * 200;
      const grad = g.createLinearGradient(0, 488 - len, 0, 488);
      grad.addColorStop(0, 'rgba(110,58,24,0)');
      grad.addColorStop(1, 'rgba(110,58,24,0.55)');
      g.fillStyle = grad;
      g.fillRect(x, 488 - len, 2 + noise(i) * 5, len);
    }
    const grime = g.createLinearGradient(0, 380, 0, 488);
    grime.addColorStop(0, 'rgba(10,9,8,0)');
    grime.addColorStop(1, 'rgba(10,9,8,0.55)');
    g.fillStyle = grime;
    g.fillRect(0, 380, 256, 108);
    g.fillStyle = '#18191c';
    g.fillRect(0, 488, 256, 24);
    for (let x = -24; x < 256; x += 24) {
      g.fillStyle = '#a8862e';
      g.beginPath();
      g.moveTo(x, 512);
      g.lineTo(x + 12, 496);
      g.lineTo(x + 24, 496);
      g.lineTo(x + 12, 512);
      g.fill();
    }
  });
}

/** A worn yellow floor line along u (alpha where the paint is gone), 4 m per repeat. */
export function lineTexture(): THREE.CanvasTexture {
  const t = canvasTexture(512, 32, (g) => {
    g.fillStyle = '#c9a23a';
    g.fillRect(0, 2, 512, 28);
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 90; i++) blot(g, noise(i * 3.7) * 512, noise(i * 1.9) * 32, 4 + noise(i) * 14, '0,0,0', 0.8, i * 7);
    g.globalCompositeOperation = 'source-over';
  });
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** An oil stain decal: dark, irregular, its edge soaked into the concrete. */
export function stainTexture(): THREE.CanvasTexture {
  const t = canvasTexture(256, 256, (g) => {
    blot(g, 128, 128, 120, '46,34,22', 0.28, 3);
    blot(g, 120, 134, 70, '12,10,9', 0.45, 11);
    // Splashes and drips round the main puddle, so it never reads as a disc.
    for (let i = 0; i < 9; i++) blot(g, 128 + (noise(i * 2.1) - 0.5) * 190, 128 + (noise(i * 4.3) - 0.5) * 190, 6 + noise(i) * 20, '12,10,9', 0.4, i * 29);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Diamond plate for the turntable's top: alternating raised lugs, scuffed paths and a worn rim. */
export function plateTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, (g) => {
    g.fillStyle = '#6c6d72';
    g.fillRect(0, 0, 512, 512);
    for (let y = 0; y < 512; y += 16) {
      for (let x = 0; x < 512; x += 16) {
        const flip = ((x + y) / 16) & 1;
        g.save();
        g.translate(x + 8, y + 8);
        g.rotate(flip ? Math.PI / 4 : -Math.PI / 4);
        g.fillStyle = '#9a9ba2';
        g.fillRect(-6, -1.5, 12, 3);
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(-6, 1.5, 12, 1.5);
        g.restore();
      }
    }
    // Tire paths across it and a grimy rim.
    g.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      g.strokeStyle = 'rgba(10,10,10,0.18)';
      g.lineWidth = 40 + noise(i) * 30;
      const a = noise(i * 3.3) * Math.PI;
      g.beginPath();
      g.moveTo(256 - Math.cos(a) * 260, 256 - Math.sin(a) * 260);
      g.lineTo(256 + Math.cos(a) * 260, 256 + Math.sin(a) * 260);
      g.stroke();
    }
    const rim = g.createRadialGradient(256, 256, 190, 256, 256, 256);
    rim.addColorStop(0, 'rgba(12,11,10,0)');
    rim.addColorStop(1, 'rgba(12,11,10,0.65)');
    g.fillStyle = rim;
    g.fillRect(0, 0, 512, 512);
  });
}

/** Yellow and black chevrons for the ring round the turntable, chipped. */
export function hazardTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 32, (g) => {
    g.fillStyle = '#141316';
    g.fillRect(0, 0, 64, 32);
    g.fillStyle = '#9c8034';
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(32, 0);
    g.lineTo(64, 32);
    g.lineTo(32, 32);
    g.fill();
    for (let i = 0; i < 10; i++) {
      g.fillStyle = 'rgba(30,28,26,0.8)';
      g.fillRect(noise(i * 5.5) * 64, noise(i * 2.2) * 32, 2 + noise(i) * 5, 1 + noise(i * 9) * 3);
    }
  });
}

/** Pegboard crowded with tools: spanners, screwdrivers, sockets, pliers, a hammer, a saw and an air line. */
export function pegboardTexture(): THREE.CanvasTexture {
  return canvasTexture(768, 384, (g) => {
    g.fillStyle = '#3a3226';
    g.fillRect(0, 0, 768, 384);
    g.fillStyle = '#16120d';
    for (let y = 8; y < 384; y += 16) for (let x = 8; x < 768; x += 16) g.fillRect(x, y, 4, 4);
    // Outlines painted round each tool's place, the shadow-board way.
    const outline = (x: number, y: number, w: number, h: number) => {
      g.strokeStyle = 'rgba(230,220,200,0.35)';
      g.lineWidth = 2;
      g.strokeRect(x - 3, y - 3, w + 6, h + 6);
    };
    g.fillStyle = '#9ba0a8';
    for (let i = 0; i < 9; i++) {
      const x = 24 + i * 26;
      const len = 80 + i * 10;
      g.fillRect(x, 40, 8, len);
      g.beginPath();
      g.arc(x + 4, 40, 11, 0, Math.PI * 2);
      g.arc(x + 4, 40 + len, 9, 0, Math.PI * 2);
      g.fill();
    }
    // Screwdrivers: colored handles, steel shafts.
    const handles = ['#c23a2a', '#d9a826', '#2a6fc2', '#1d1d1d', '#c23a2a', '#3c9a46'];
    handles.forEach((c, i) => {
      const x = 280 + i * 22;
      g.fillStyle = c;
      g.fillRect(x, 40, 12, 46);
      g.fillStyle = '#b8bcc4';
      g.fillRect(x + 4, 86, 4, 60 + (i % 3) * 14);
    });
    // A socket rail.
    outline(270, 200, 150, 30);
    g.fillStyle = '#3c3f46';
    g.fillRect(270, 210, 150, 8);
    for (let i = 0; i < 9; i++) {
      g.fillStyle = '#b2b6be';
      g.fillRect(274 + i * 16, 196 + (i % 3), 12, 18 + i);
    }
    // Pliers, a hammer, a hacksaw.
    g.fillStyle = PALETTE.orange;
    g.fillRect(450, 60, 10, 90);
    g.fillRect(470, 60, 10, 90);
    g.fillStyle = '#9ba0a8';
    g.fillRect(452, 150, 26, 36);
    g.fillStyle = '#5a3a24';
    g.fillRect(520, 60, 14, 120);
    g.fillStyle = '#9ba0a8';
    g.fillRect(500, 46, 54, 24);
    outline(570, 260, 170, 50);
    g.strokeStyle = '#8a8e96';
    g.lineWidth = 6;
    g.strokeRect(580, 268, 120, 34);
    g.fillStyle = '#2a6fc2';
    g.fillRect(700, 266, 34, 38);
    // A coiled air line and a missing tool's empty outline.
    g.strokeStyle = '#d9b44a';
    g.lineWidth = 6;
    for (let r = 20; r < 52; r += 8) {
      g.beginPath();
      g.arc(640, 120, r, 0, Math.PI * 2);
      g.stroke();
    }
    outline(40, 240, 160, 40);
    // Grime: hand marks round the busiest spots, dust along the top.
    for (let i = 0; i < 16; i++) blot(g, noise(i * 6.1) * 768, 100 + noise(i * 3.3) * 280, 20 + noise(i) * 30, '0,0,0', 0.18, i * 19);
  });
}

/** A tool chest's drawer fronts in a body color: seams, chrome pulls, scratches and a sticker or two. */
export function drawerTexture(body: string): THREE.CanvasTexture {
  return canvasTexture(256, 192, (g) => {
    g.fillStyle = body;
    g.fillRect(0, 0, 256, 192);
    const rows = [0, 20, 40, 60, 84, 112, 148, 192];
    for (let i = 0; i < rows.length - 1; i++) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(0, rows[i + 1] - 2, 256, 2);
      g.fillStyle = '#d9dde5';
      g.fillRect(24, rows[i] + 5, 208, 3);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(24, rows[i] + 8, 208, 1);
    }
    for (let i = 0; i < 30; i++) {
      g.strokeStyle = 'rgba(255,255,255,0.12)';
      g.lineWidth = 1;
      const x = noise(i * 3.9) * 256;
      const y = noise(i * 7.1) * 192;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 6 + noise(i) * 20, y + (noise(i * 2.3) - 0.5) * 6);
      g.stroke();
    }
    g.fillStyle = PALETTE.yellow;
    g.fillRect(180, 120, 46, 20);
    g.fillStyle = '#111';
    g.fillRect(186, 126, 34, 8);
    g.fillStyle = PALETTE.cyan;
    g.beginPath();
    g.arc(60, 160, 12, 0, Math.PI * 2);
    g.fill();
  });
}

/** A poster for one of the game's fictional tuners, aged: faded, creased, taped at the corners, one corner torn. */
export function posterTexture(name: string, line: string, accent: string, variant: number): THREE.CanvasTexture {
  return canvasTexture(256, 360, (g) => {
    g.fillStyle = '#1b1a1f';
    g.fillRect(0, 0, 256, 360);
    g.fillStyle = accent;
    if (variant === 0) {
      g.beginPath();
      g.moveTo(30, 150);
      g.lineTo(226, 120);
      g.lineTo(226, 140);
      g.lineTo(30, 172);
      g.fill();
      g.fillRect(80, 160, 10, 60);
      g.fillRect(170, 146, 10, 60);
    } else if (variant === 1) {
      for (let i = 0; i < 9; i++) g.fillRect(20 + i * 6, 70 + i * 18, 216 - i * 18, 7);
    } else {
      g.lineWidth = 14;
      g.strokeStyle = accent;
      g.beginPath();
      g.arc(128, 150, 80, 0, Math.PI * 2);
      g.stroke();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        g.beginPath();
        g.moveTo(128, 150);
        g.lineTo(128 + Math.cos(a) * 76, 150 + Math.sin(a) * 76);
        g.stroke();
      }
    }
    g.fillStyle = '#f2efe8';
    g.font = 'italic 900 40px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(name, 20, 290);
    g.fillStyle = accent;
    g.font = '700 17px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(line, 22, 318);
    g.fillRect(22, 330, 60, 4);
    // Age: a yellow cast, fold creases, scuffs.
    g.fillStyle = 'rgba(150,120,60,0.16)';
    g.fillRect(0, 0, 256, 360);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, 179, 256, 2);
    g.fillRect(127, 0, 2, 360);
    for (let i = 0; i < 8; i++) blot(g, noise(i * 4.9 + variant) * 256, noise(i * 8.3 + variant) * 360, 14 + noise(i) * 24, '20,16,10', 0.22, i * 7 + variant);
    // Tape at three corners; the fourth is torn off.
    g.fillStyle = 'rgba(220,210,170,0.75)';
    g.fillRect(-6, 6, 40, 14);
    g.fillRect(222, 6, 40, 14);
    g.fillRect(-6, 336, 40, 14);
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.moveTo(256, 300);
    g.lineTo(256, 360);
    g.lineTo(196, 360);
    g.lineTo(220, 344);
    g.lineTo(232, 326);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  });
}

/** A soft round glow (white, alpha falling off), for light spilling on the wall round a sign or a lamp. */
export function glowTexture(): THREE.CanvasTexture {
  const t = canvasTexture(128, 128, (g) => {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** The contact shadow: a soft rounded rectangle, darkest under the car's middle. */
export function shadowTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  const t = canvasTexture(
    w,
    h,
    (g) => {
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = Math.abs((x + 0.5) / w - 0.5) * 2;
          const py = Math.abs((y + 0.5) / h - 0.5) * 2;
          const qx = Math.max(px - 0.6, 0);
          const qy = Math.max(py - 0.72, 0);
          const d = Math.hypot(qx / 0.4, qy / 0.28);
          const a = Math.max(0, 1 - d) ** 1.8 * (0.75 + 0.25 * (1 - py));
          const i = (y * w + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
          img.data[i + 3] = Math.round(a * 255);
        }
      }
      g.putImageData(img, 0, 0);
    },
    false,
  );
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
