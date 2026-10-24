/**
 * The shop's working paper as canvas textures: the pegboard, drawer fronts,
 * the jobs whiteboard and the work orders in the marker hand, and the tuners'
 * parts boxes. Each is drawn once per visit from a fixed hash. Render only.
 */
import * as THREE from 'three';
import { drawTexture, fitFont } from '../../render/textures/canvasKit';
import { PALETTE } from '../../ui/kit/palette';
import { blot, HAND, noise } from './brushes';

/** Pegboard crowded with tools: spanners, screwdrivers, sockets, pliers, a hammer, a saw and an air line. */
export function pegboardTexture(): THREE.CanvasTexture {
  return drawTexture(768, 384, (g) => {
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
  return drawTexture(256, 192, (g) => {
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

/** The jobs board: tonight's work by bay in marker, ticks and a crossed-out line, a parts reminder in red, a sketch, old ghosting. */
export function whiteboardTexture(): THREE.CanvasTexture {
  return drawTexture(512, 288, (g) => {
    g.fillStyle = '#e4e6e3';
    g.fillRect(0, 0, 512, 288);
    // Ghosts of wiped jobs and a grimy edge.
    g.fillStyle = 'rgba(70,80,110,0.09)';
    for (let i = 0; i < 9; i++) g.fillRect(30 + noise(i * 3.1) * 300, 40 + noise(i * 5.7) * 200, 60 + noise(i) * 120, 10);
    g.strokeStyle = '#8d9096';
    g.lineWidth = 12;
    g.strokeRect(0, 0, 512, 288);
    g.fillStyle = '#1c2a6b';
    g.font = `700 30px ${HAND}`;
    g.fillText('TONIGHT', 24, 44);
    g.fillRect(24, 52, 132, 3);
    g.font = `22px ${HAND}`;
    const jobs: [string, string, boolean][] = [
      ['BAY 1', 'cat-back + tune', true],
      ['BAY 2', 'pads, rotors, hubs', false],
      ['BAY 3', 'oil + diff fluid', true],
      ['BAY 4', 'coilovers -> align', false],
      ['FLOOR', 'motor out, reseal', false],
    ];
    jobs.forEach(([bay, job, done], i) => {
      const y = 90 + i * 36;
      g.fillStyle = '#1c2a6b';
      g.fillText(bay, 24, y);
      g.fillStyle = '#20232a';
      g.fillText(job, 110, y);
      if (done) {
        g.strokeStyle = '#2a8c3e';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(300, y - 8);
        g.lineTo(308, y);
        g.lineTo(324, y - 18);
        g.stroke();
      }
    });
    g.strokeStyle = '#20232a';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(108, 154);
    g.lineTo(270, 148);
    g.stroke();
    g.fillStyle = '#b3242c';
    g.font = `700 24px ${HAND}`;
    g.fillText('PARTS DUE FRI!', 330, 236);
    g.fillText('KIBA x4', 360, 266);
    // A quick sketch of a wing and its uprights.
    g.strokeStyle = '#1c2a6b';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(350, 120);
    g.quadraticCurveTo(420, 96, 490, 112);
    g.lineTo(486, 128);
    g.quadraticCurveTo(420, 114, 352, 136);
    g.closePath();
    g.moveTo(390, 126);
    g.lineTo(386, 180);
    g.moveTo(452, 116);
    g.lineTo(456, 176);
    g.stroke();
    g.font = `18px ${HAND}`;
    g.fillStyle = '#1c2a6b';
    g.fillText('1650 wide?', 380, 82);
  });
}

/** A work order on a clipboard: the printed header and boxes, the job written in, a greasy thumbprint. */
export function workOrderTexture(): THREE.CanvasTexture {
  return drawTexture(128, 176, (g) => {
    g.fillStyle = '#ebe7dc';
    g.fillRect(0, 0, 128, 176);
    g.fillStyle = '#26282d';
    g.font = '700 13px "Google Sans Flex", system-ui, sans-serif';
    g.fillText('WORK ORDER', 10, 20);
    g.fillStyle = PALETTE.orange;
    g.fillRect(10, 26, 108, 3);
    g.strokeStyle = 'rgba(40,40,46,0.45)';
    g.lineWidth = 1;
    for (let y = 44; y < 160; y += 14) {
      g.beginPath();
      g.moveTo(10, y);
      g.lineTo(118, y);
      g.stroke();
    }
    g.fillStyle = '#1c2a6b';
    g.font = `12px ${HAND}`;
    ['front pads', 'rotors x2', 'bleed - DOT4', 'torque 108'].forEach((t, i) => g.fillText(t, 12, 41 + i * 14 * 2));
    blot(g, 96, 140, 10, '40,30,20', 0.35, 3);
  });
}

/** A tuner's parts box: cardboard printed with the brand and its line, the this-way-up arrows and a shipping label. */
export function partsBoxTexture(name: string, line: string, accent: string): THREE.CanvasTexture {
  return drawTexture(256, 256, (g) => {
    g.fillStyle = '#86663f';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 6; i++) blot(g, noise(i * 6.1 + name.length) * 256, noise(i * 2.7) * 256, 20 + noise(i) * 30, '60,40,20', 0.18, i);
    g.fillStyle = '#16151a';
    g.fillRect(0, 96, 256, 64);
    g.fillStyle = accent;
    g.fillRect(0, 156, 256, 4);
    g.fillStyle = '#f2efe8';
    fitFont(g, name, 230, 44, (px) => `italic 900 ${px}px "Google Sans Flex", system-ui, sans-serif`);
    g.fillText(name, 14, 142);
    g.fillStyle = '#16151a';
    g.font = '700 16px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(line, 14, 186);
    g.fillStyle = '#ebe7dc';
    g.fillRect(150, 200, 92, 44);
    g.fillStyle = '#26282d';
    for (let i = 0; i < 4; i++) g.fillRect(156, 208 + i * 9, 40 + noise(i + name.length) * 40, 3);
    g.strokeStyle = '#16151a';
    g.lineWidth = 4;
    for (const x of [24, 60]) {
      g.beginPath();
      g.moveTo(x, 70);
      g.lineTo(x, 24);
      g.moveTo(x - 10, 36);
      g.lineTo(x, 24);
      g.lineTo(x + 10, 36);
      g.stroke();
    }
  });
}
