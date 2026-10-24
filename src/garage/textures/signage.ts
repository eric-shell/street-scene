/**
 * The garage's signs and wall hangings as canvas textures: aged posters, the
 * flagship nameplates, the beer sign, exit signs, bay numbers, the tuners'
 * banners, old number plates, the clock and the supplier's calendar. Each is
 * drawn once per visit from a fixed hash. Render only.
 */
import * as THREE from 'three';
import { drawTexture, fitFont } from '../../render/textures/canvasKit';
import { PALETTE } from '../../ui/kit/palette';
import { blot, HAND, noise } from './brushes';

/** A poster for one of the game's fictional tuners, aged: faded, creased, taped at the corners, one corner torn. */
export function posterTexture(name: string, line: string, accent: string, variant: number): THREE.CanvasTexture {
  return drawTexture(256, 360, (g) => {
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

/**
 * The flagship cabs' nameplates, one row each in an atlas: a black plate with
 * the series name lit in its accent. The material pushes it past the bloom.
 */
export function badgeTexture(badges: readonly { name: string; line: string; color: string }[]): THREE.CanvasTexture {
  return drawTexture(
    512,
    96 * badges.length,
    (g) => {
      badges.forEach(({ name, line, color }, i) => {
        const y = i * 96;
        g.fillStyle = '#0b0b0e';
        g.fillRect(0, y, 512, 96);
        g.strokeStyle = '#9aa0aa';
        g.lineWidth = 4;
        g.strokeRect(4, y + 4, 504, 88);
        g.fillStyle = color;
        g.textAlign = 'center';
        fitFont(g, name, 440, 54, (px) => `italic 900 ${px}px "Google Sans Flex", system-ui, sans-serif`);
        g.fillText(name, 256, y + 58);
        g.font = '700 18px "Google Sans Flex", system-ui, sans-serif';
        g.fillText(line, 256, y + 82);
      });
    },
    { repeat: false },
  );
}

/** The beer sign's face: two lines of light on black, drawn white so the material's color tints and pushes it past the bloom. */
export function beerSignTexture(): THREE.CanvasTexture {
  return drawTexture(
    256,
    128,
    (g) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, 256, 128);
      g.strokeStyle = '#fff';
      g.lineWidth = 4;
      g.strokeRect(8, 8, 240, 112);
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      fitFont(g, 'COLD BEER', 220, 48, (px) => `italic 800 ${px}px ${HAND}`);
      g.fillText('COLD BEER', 128, 62);
      g.font = `600 22px "Google Sans Flex", system-ui, sans-serif`;
      g.fillText('AFTER HOURS', 128, 100);
    },
    { repeat: false },
  );
}

/** An exit sign's face: the word and an arrow, lit green on dark glass. */
export function exitTexture(): THREE.CanvasTexture {
  return drawTexture(
    256,
    96,
    (g) => {
      g.fillStyle = '#071209';
      g.fillRect(0, 0, 256, 96);
      g.fillStyle = '#3cff7a';
      g.textAlign = 'center';
      g.font = '800 58px "Google Sans Flex", system-ui, sans-serif';
      g.fillText('EXIT', 112, 70);
      g.beginPath();
      g.moveTo(206, 30);
      g.lineTo(236, 48);
      g.lineTo(206, 66);
      g.lineTo(206, 56);
      g.lineTo(190, 56);
      g.lineTo(190, 40);
      g.lineTo(206, 40);
      g.fill();
    },
    { repeat: false },
  );
}

/** The bay numbers 1 to 4 in a row of cells, painted big in worn yellow on the floor. */
export function bayNumbersTexture(): THREE.CanvasTexture {
  return drawTexture(
    512,
    128,
    (g) => {
      g.textAlign = 'center';
      g.font = '900 118px "Google Sans Flex", system-ui, sans-serif';
      for (let i = 0; i < 4; i++) {
        g.fillStyle = '#c9a227';
        g.fillText(String(i + 1), i * 128 + 64, 112);
      }
      // Worn through where the tires run over it.
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 500; i++) {
        g.fillStyle = `rgba(0,0,0,${0.3 + noise(i * 1.7) * 0.6})`;
        g.fillRect(noise(i * 2.3) * 512, noise(i * 3.1) * 128, 2 + noise(i) * 8, 1 + noise(i * 5.9) * 4);
      }
      g.globalCompositeOperation = 'source-over';
    },
    { repeat: false },
  );
}

/** The tuners' cloth banners, one per 512 x 192 row: brand, line, a stripe in its color, the weave and the grommets. */
export function bannerTexture(banners: readonly { name: string; line: string; color: string }[]): THREE.CanvasTexture {
  return drawTexture(
    512,
    192 * banners.length,
    (g) => {
      banners.forEach(({ name, line, color }, i) => {
        const y = i * 192;
        g.fillStyle = '#121115';
        g.fillRect(0, y, 512, 192);
        g.fillStyle = color;
        g.fillRect(0, y + 132, 512, 10);
        g.beginPath();
        g.moveTo(0, y + 18);
        g.lineTo(120, y + 18);
        g.lineTo(90, y + 30);
        g.lineTo(0, y + 30);
        g.fill();
        g.fillStyle = '#f2efe8';
        fitFont(g, name, 470, 92, (px) => `italic 900 ${px}px "Google Sans Flex", system-ui, sans-serif`);
        g.fillText(name, 22, y + 118);
        g.fillStyle = color;
        g.font = '700 26px "Google Sans Flex", system-ui, sans-serif';
        g.fillText(line, 24, y + 176);
        g.fillStyle = 'rgba(255,255,255,0.035)';
        for (let x = 0; x < 512; x += 3) g.fillRect(x, y, 1, 192);
        for (let k = 0; k < 192; k += 3) g.fillRect(0, y + k, 512, 1);
        g.fillStyle = '#9aa0aa';
        for (const gx of [12, 500]) {
          g.beginPath();
          g.arc(gx, y + 10, 5, 0, Math.PI * 2);
          g.fill();
        }
      });
    },
    { repeat: false },
  );
}

/** Old number plates nailed up in a row: six fictional plates, faded, one rusted. */
export function platesTexture(): THREE.CanvasTexture {
  const plates: [string, string, string, string][] = [
    ['NGHT RN', 'NIGHT CITY', '#e9e4d6', '#1c2a6b'],
    ['SCN 01', 'HARBOR DIST.', '#f2c230', '#16151a'],
    ['DRFT 4U', 'MIDTOWN', '#dfe6ee', '#b3242c'],
    ['BOOST', 'RIVERSIDE', '#16151a', '#e9e4d6'],
    ['2JZ', 'OLD TOWN', '#e9e4d6', '#0e7a5a'],
    ['LATE NT', 'NIGHT CITY', '#c9ced8', '#16151a'],
  ];
  return drawTexture(
    768,
    128,
    (g) => {
      plates.forEach(([text, line, bg, ink], i) => {
        const x = i * 128;
        g.fillStyle = bg;
        g.fillRect(x + 4, 24, 120, 64);
        g.strokeStyle = ink;
        g.lineWidth = 3;
        g.strokeRect(x + 8, 28, 112, 56);
        g.fillStyle = ink;
        g.textAlign = 'center';
        fitFont(g, text, 100, 30, (px) => `800 ${px}px "Google Sans Flex", system-ui, sans-serif`);
        g.fillText(text, x + 64, 70);
        g.font = '700 9px "Google Sans Flex", system-ui, sans-serif';
        g.fillText(line, x + 64, 40);
        for (let k = 0; k < 4; k++) blot(g, x + 10 + noise(i * 9 + k) * 108, 30 + noise(i * 5 + k) * 52, 6 + noise(k) * 8, i === 3 ? '120,60,20' : '60,50,40', i === 3 ? 0.4 : 0.15, i * 11 + k);
      });
    },
    { repeat: false },
  );
}

/** The shop clock's face: numerals, ticks and the hands stopped at a quarter to three, the night long. */
export function clockTexture(): THREE.CanvasTexture {
  return drawTexture(
    256,
    256,
    (g) => {
      g.fillStyle = '#e9e7e0';
      g.beginPath();
      g.arc(128, 128, 124, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#16151a';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = '700 26px "Google Sans Flex", system-ui, sans-serif';
      for (let i = 1; i <= 12; i++) {
        const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
        g.fillText(String(i), 128 + Math.cos(a) * 96, 128 + Math.sin(a) * 96);
      }
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2;
        const l = i % 5 ? 6 : 12;
        g.fillRect(128 + Math.cos(a) * (118 - l) - 1, 128 + Math.sin(a) * (118 - l) - 1, 2 + Math.cos(a) * 0, 2);
      }
      const hand = (a: number, len: number, w: number, c: string) => {
        g.strokeStyle = c;
        g.lineWidth = w;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(128, 128);
        g.lineTo(128 + Math.cos(a - Math.PI / 2) * len, 128 + Math.sin(a - Math.PI / 2) * len);
        g.stroke();
      };
      hand(((2 + 45 / 60) / 12) * Math.PI * 2, 60, 8, '#16151a');
      hand((45 / 60) * Math.PI * 2, 92, 5, '#16151a');
      hand((20 / 60) * Math.PI * 2, 98, 2, '#b3242c');
    },
    { repeat: false },
  );
}

/** A parts supplier's wall calendar: a car photo up top (a silhouette under a sunset), the month's grid below. */
export function calendarTexture(): THREE.CanvasTexture {
  return drawTexture(256, 360, (g) => {
    g.fillStyle = '#ebe7dc';
    g.fillRect(0, 0, 256, 360);
    const sky = g.createLinearGradient(0, 0, 0, 160);
    sky.addColorStop(0, '#2a1640');
    sky.addColorStop(1, '#ff7a3c');
    g.fillStyle = sky;
    g.fillRect(10, 10, 236, 150);
    g.fillStyle = '#0d0d10';
    g.beginPath();
    g.moveTo(30, 140);
    g.lineTo(60, 112);
    g.lineTo(120, 100);
    g.lineTo(170, 104);
    g.lineTo(220, 122);
    g.lineTo(228, 140);
    g.fill();
    for (const wx of [72, 190]) {
      g.beginPath();
      g.arc(wx, 140, 14, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#26282d';
    g.font = '800 26px "Google Sans Flex", system-ui, sans-serif';
    g.fillText('OCTOBER', 14, 192);
    g.fillStyle = PALETTE.orange;
    g.font = '700 12px "Google Sans Flex", system-ui, sans-serif';
    g.fillText('KUROGANE AERO WORKS', 140, 192);
    g.strokeStyle = 'rgba(40,40,46,0.5)';
    g.lineWidth = 1;
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 7; c++) {
        g.strokeRect(12 + c * 33, 204 + r * 30, 33, 30);
        const day = r * 7 + c - 2;
        if (day > 0 && day <= 31) {
          g.fillStyle = '#26282d';
          g.font = '10px "Google Sans Flex", system-ui, sans-serif';
          g.fillText(String(day), 15 + c * 33, 215 + r * 30);
        }
      }
    // Today circled in marker, a meet on the weekend.
    g.strokeStyle = '#b3242c';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(12 + 4 * 33 + 16, 204 + 3 * 30 + 15, 14, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#1c2a6b';
    g.font = `12px ${HAND}`;
    g.fillText('meet!', 12 + 6 * 33 + 2, 204 + 3 * 30 + 26);
  });
}
