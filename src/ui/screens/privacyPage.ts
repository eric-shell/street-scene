/**
 * The settings panel's Privacy page: the switch for sharing anonymous play data (the device's opt-out flag the
 * analytics client honors, analytics/telemetry.ts), then the note on exactly what is collected, why, and how
 * to get it deleted. The wording is the promise the analytics make (docs/analytics.md): change one, change both.
 * Styled by _privacy.scss.
 */
import { h } from '../kit/dom';
import { analyticsAllowed, privacySignal, setAnalyticsOptOut } from '../../analytics/telemetry';
import { onOff, settingRow } from './settingsPanel';

/** A headed group of the note: a title, then a sentence or a short list. */
function group(title: string, ...body: (string | string[])[]): HTMLElement {
  return h(
    'section',
    { class: 'privacy__group' },
    h('h3', { class: 'section-title privacy__title' }, title),
    ...body.map((b) => (typeof b === 'string' ? h('p', {}, b) : h('ul', {}, ...b.map((li) => h('li', {}, li))))),
  );
}

export function privacyPage(): HTMLElement[] {
  const signal = privacySignal();
  const control = onOff(!signal && analyticsAllowed(), (on) => setAnalyticsOptOut(!on));
  if (signal) control.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
  if (signal) control.querySelector('.is-selected')?.classList.remove('is-selected');
  if (signal) control.querySelector('button')?.classList.add('is-selected');
  const hint = signal ? 'Your browser asks not to be tracked, so nothing is sent' : 'Turning it off stops sending now; turning it on starts at the next load';
  return [
    settingRow('Share anonymous play data', control, hint),
    h(
      'div',
      { class: 'privacy' },
      group(
        'What is collected, and only while this is on',
        'A random id stored in this browser (not linked to you unless you sign in).',
        [
          'Each visit: which screen link you opened, how long the game was visible and how long you drove, your screen and window size, browser language and time zone, the site that sent you, the game version.',
          'Your approximate location (country, region, city) worked out from your IP address by our host; the address itself is not stored.',
          'Your browser and device: browser name and version, graphics chip, screen pixel density, processor cores, memory, touch screen.',
          'What you do in the game: races started, finished or left (mode, city seed, car, time, place, how far you got), a frame-rate summary per drive, garage visits, builds saved, shared or imported, signing in and out.',
        ],
      ),
      group('If you sign in', "These visits are linked to your Google account's name and email (which the account already stores for syncing your garage)."),
      group('What it is for', 'Seeing which modes and cars people play, where races get abandoned, and which devices run the game slowly.'),
      group('What it is not', [
        'No advertising, no third-party analytics or trackers, never sold or shared.',
        'Stored in the game’s own database (Neon, hosted through Vercel).',
        'Your IP address is used briefly to limit abuse and is not kept with any of this.',
      ]),
      group('How long', 'Visit and page records are deleted after 6 months; the rest is kept until it is deleted.'),
      group('Your choices', [
        'The switch above.',
        'Global Privacy Control and Do Not Track are honored.',
        'Signed-in players can ask for their data to be deleted: ask the developer.',
      ]),
    ),
  ];
}
