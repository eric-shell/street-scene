/**
 * Music player UI. Always shows credit for the current track: title, artist,
 * album, source and license, each linked. It stands in one place on every
 * screen, the top right corner, so the music never moves between the menu,
 * the garage, a race and the drone. Modes:
 *  - full: the player card; can be minimized to a pill in the same corner
 *  - compact: a race's now-playing chip, the pill's twin (controls via M, [ and ])
 *  - hidden
 * A new track glints across the piece on show; the pill and the chip, which
 * name only the title, also drop a small now-playing toast under them with the
 * full credit (the card already shows it). Styled by _music-player.scss and,
 * for the library dialog, _music-library.scss.
 *
 * Every screen's help button stands just left of whichever piece is on show
 * (card, pill or chip), so the corner reads as one row of controls: the widget
 * publishes that piece's place as `--help-right` and `--help-top` (with
 * `body.is-music-top`; `--help-bottom` for a piece low on the screen) on the
 * document, read by panels/_help.scss. Only on changes (mode, track, size,
 * resize), never per frame.
 */
import { MUSIC_CATALOG, type MusicPlayer, type MusicTrack } from '../../audio/musicPlayer';
import { btn, h, iconBtn, isTyping, link, sheen } from '../kit/dom';
import { ChevronLeft, Disc3, ListMusic, Minimize2, Music, Pause, Play, Shuffle, SkipBack, SkipForward, Volume2, VolumeX, X, icon, type IconNode } from '../kit/icons';
import { formatClock } from '../kit/format';

export type MusicMode = 'full' | 'compact' | 'hidden';

/** How long the now-playing toast stays up, ms. */
const TOAST_MS = 5000;

/** Artist · Album, linked. */
function byLine(t: MusicTrack): (Node | string)[] {
  return [link(t.artistUrl, t.artist), ' · ', link(t.albumUrl, t.albumShort)];
}

/** Source · License, linked. */
function sourceLine(t: MusicTrack): (Node | string)[] {
  return [link(t.sourceUrl, t.source), ' · ', link(t.licenseUrl, t.license)];
}

/** An icon button whose glyph changes with the player's state: swap the glyph, keep the sheen. */
function setGlyph(b: HTMLButtonElement, node: IconNode, label: string): void {
  b.firstElementChild?.replaceWith(icon(node, { size: 18 }));
  b.setAttribute('aria-label', label);
  b.title = label;
}

/** Replay a one-shot class (the glint, the toast's entrance) even if it is already on. */
function replay(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export class MusicWidget {
  private root: HTMLElement;
  private card: HTMLElement;
  private pill: HTMLButtonElement;
  private chip: HTMLElement;
  private toast: HTMLElement;
  private library: HTMLElement | null = null;
  private titleEl: HTMLElement;
  private artistEl: HTMLElement;
  private sourceEl: HTMLElement;
  private fill: HTMLElement;
  private timeEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private shuffleBtn: HTMLButtonElement;
  private vol: HTMLInputElement;
  private disc: HTMLElement;
  private mode: MusicMode = 'hidden';
  private toastTimer = 0;
  private lastTrack: string | null = null;

  constructor(
    parent: HTMLElement,
    private readonly player: MusicPlayer,
  ) {
    this.titleEl = h('div', { class: 'music-player__title' });
    this.artistEl = h('div', { class: 'music-player__artist' });
    this.sourceEl = h('div', { class: 'music-player__source' });
    this.fill = h('div', { class: 'music-player__fill' });
    this.timeEl = h('div', { class: 'music-player__time' });
    const bar = h('div', { class: 'music-player__bar', role: 'slider', 'aria-label': 'Seek' }, this.fill);
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      player.seek((e.clientX - r.left) / r.width);
    });
    // One lit control at a time: play is the primary action, the rest stay quiet until hovered or on.
    this.playBtn = iconBtn(Play, 'Play', () => player.toggle(), '--primary music-player__play');
    this.muteBtn = iconBtn(Volume2, 'Mute', () => player.setMuted(!player.muted), '--ghost music-player__toggle');
    this.shuffleBtn = iconBtn(Shuffle, 'Shuffle', () => player.setShuffle(!player.shuffle), '--ghost music-player__toggle');
    this.vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': 'Music volume', class: 'music-player__volume' }) as HTMLInputElement;
    this.vol.addEventListener('input', () => player.setVolume(Number(this.vol.value)));
    this.disc = h('span', { class: 'music-player__disc' }, icon(Disc3, { size: 14 }));
    this.card = h(
      'div',
      { class: 'music-player__card', role: 'region', 'aria-label': 'Music player' },
      h(
        'div',
        { class: 'music-player__top' },
        h('span', { class: 'label label--kicker' }, this.disc, 'Now playing'),
        h(
          'span',
          { class: 'music-player__actions' },
          iconBtn(ListMusic, 'Music library', () => this.openLibrary(), '--ghost'),
          iconBtn(Minimize2, 'Minimize player', () => player.setMinimized(true), '--ghost'),
        ),
      ),
      this.titleEl,
      this.artistEl,
      h('div', { class: 'music-player__progress' }, bar, this.timeEl),
      h(
        'div',
        { class: 'music-player__controls' },
        this.shuffleBtn,
        iconBtn(SkipBack, 'Previous track', () => player.prev(), '--ghost'),
        this.playBtn,
        iconBtn(SkipForward, 'Next track', () => player.next(), '--ghost'),
        h('span', { class: 'music-player__mix' }, this.muteBtn, this.vol),
      ),
      this.sourceEl,
      sheen(),
    );
    this.pill = h('button', { class: 'music-player__pill', type: 'button', 'aria-label': 'Show music player' }) as HTMLButtonElement;
    this.pill.addEventListener('click', () => player.setMinimized(false));
    this.chip = h('div', { class: 'music-player__chip', role: 'status', 'aria-label': 'Now playing' });
    this.toast = h('div', { class: 'music-player__toast', 'aria-live': 'polite' });
    // The dock is the corner: the piece on show, with the toast hanging under it.
    this.root = h('div', { class: 'music-player' }, h('div', { class: 'music-player__dock' }, this.card, this.pill, this.chip, this.toast));
    parent.append(this.root);
    // Sizes change with the title and the media queries; places with the viewport.
    const ro = new ResizeObserver(() => this.dock());
    for (const el of [this.card, this.pill, this.chip]) ro.observe(el);
    window.addEventListener('resize', () => this.dock());

    player.on('track', () => this.onTrack());
    player.on('state', () => this.render());
    player.on('time', () => this.renderTime());
    window.addEventListener('keydown', (e) => {
      // Ctrl+M, Cmd+[ and the like belong to the browser and the OS.
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
      if (e.code === 'KeyM') player.setMuted(!player.muted);
      else if (e.code === 'BracketRight') player.next();
      else if (e.code === 'BracketLeft') player.prev();
    });
    // Phones start minimized so the player never covers controls.
    if (window.matchMedia('(max-width: 720px), (max-height: 500px)').matches && !player.minimized) player.setMinimized(true);
    this.onTrack(true);
  }

  setMode(mode: MusicMode): void {
    this.mode = mode;
    this.render();
  }

  /** The piece on show: the card, the pill or the chip, or none. */
  private shown(): HTMLElement | undefined {
    return [this.card, this.pill, this.chip].find((x) => x.getClientRects().length > 0);
  }

  /** Publish where the piece on show stands, for the help buttons beside it; nothing on show leaves them their corner. */
  private dock(): void {
    const style = document.documentElement.style;
    const r = this.shown()?.getBoundingClientRect();
    const top = !!r && r.top + r.height / 2 < window.innerHeight / 2;
    document.body.classList.toggle('is-music-top', top);
    if (!r) {
      for (const k of ['--help-right', '--help-bottom', '--help-top']) style.removeProperty(k);
      return;
    }
    style.setProperty('--help-right', `${Math.round(window.innerWidth - r.left + 8)}px`);
    style.setProperty('--help-bottom', `${Math.round(window.innerHeight - r.bottom)}px`);
    style.setProperty('--help-top', `${Math.round(r.top)}px`);
  }

  private onTrack(initial = false): void {
    const t = this.player.current;
    this.render();
    if (!t || initial || t.id === this.lastTrack) {
      this.lastTrack = t?.id ?? null;
      return;
    }
    this.lastTrack = t.id;
    this.announce(t);
  }

  /** A new track: a glint across the piece on show, and under the pill or the chip, which name only the title, the toast with the full credit. */
  private announce(t: MusicTrack): void {
    if (this.mode === 'hidden') return;
    const piece = this.shown();
    if (piece) replay(piece, 'is-fresh');
    if (!piece || piece === this.card) return;
    this.toast.replaceChildren(
      h('span', { class: 'label label--kicker music-player__toast-label' }, icon(Music, { size: 12 }), 'Now playing'),
      h('div', { class: 'music-player__toast-title' }, link(t.url, t.title)),
      h('div', { class: 'music-player__toast-credit' }, ...byLine(t), ' · ', ...sourceLine(t)),
    );
    replay(this.toast, 'is-visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('is-visible'), TOAST_MS);
  }

  private render(): void {
    const p = this.player;
    const t = p.current;
    const full = this.mode === 'full';
    this.root.dataset.mode = this.mode;
    this.card.style.display = full && !p.minimized ? '' : 'none';
    this.pill.style.display = full && p.minimized ? '' : 'none';
    this.chip.style.display = this.mode === 'compact' && t ? '' : 'none';
    // The card carries the whole credit itself: opening it puts the toast away.
    if (this.card.style.display === '' || this.mode === 'hidden') this.toast.classList.remove('is-visible');
    // A mode or screen can move the piece on show without resizing it (the observer catches the rest).
    this.dock();
    if (!t) {
      this.titleEl.textContent = 'No music installed';
      this.artistEl.textContent = 'Run npm run music';
      return;
    }
    this.titleEl.replaceChildren(link(t.url, t.title));
    this.titleEl.title = t.title;
    this.artistEl.replaceChildren(...byLine(t));
    this.sourceEl.replaceChildren(...sourceLine(t));
    setGlyph(this.playBtn, p.playing ? Pause : Play, p.playing ? 'Pause' : 'Play');
    const silent = p.muted || p.volume === 0;
    setGlyph(this.muteBtn, silent ? VolumeX : Volume2, p.muted ? 'Unmute' : 'Mute');
    this.muteBtn.classList.toggle('is-active', silent);
    this.shuffleBtn.classList.toggle('is-active', p.shuffle);
    this.shuffleBtn.setAttribute('aria-pressed', String(p.shuffle));
    this.vol.value = String(p.muted ? 0 : p.volume);
    this.disc.classList.toggle('is-spinning', p.playing && !p.muted);
    // The race's chip is the pill to the letter (muted shows as such, since only M can unmute it there).
    const glyph = () => icon(p.muted ? VolumeX : p.playing ? Disc3 : Music, { size: 16, className: p.playing && !p.muted ? 'is-spinning' : '' });
    const label = () => h('span', { class: 'music-player__pill-label' }, t.title);
    this.pill.replaceChildren(glyph(), label(), sheen());
    this.chip.replaceChildren(glyph(), label(), sheen());
    this.renderTime();
  }

  private renderTime(): void {
    const p = this.player;
    const d = p.duration;
    this.fill.style.width = d > 0 ? `${(p.time / d) * 100}%` : '0';
    this.timeEl.textContent = `${formatClock(p.time)} / ${formatClock(d)}`;
  }

  /** Library: every artist, album and track with full credits. */
  openLibrary(): void {
    this.library?.remove();
    this.toast.classList.remove('is-visible');
    const p = this.player;
    const list = h('div', { class: 'music-library__list' });
    for (const artist of MUSIC_CATALOG.artists) {
      for (const album of artist.albums) {
        list.append(
          h(
            'div',
            { class: 'music-library__album' },
            h('div', { class: 'music-library__album-title' }, link(album.url, album.title)),
            h(
              'div',
              { class: 'muted music-library__album-credit' },
              'by ',
              link(artist.url, artist.name),
              ' · Source: ',
              link(album.sourceUrl, album.source),
              ' · License: ',
              link(album.licenseUrl, album.license),
            ),
          ),
        );
        for (const tr of album.tracks) {
          const id = tr.id;
          const row = h(
            'button',
            { type: 'button', class: `music-library__track${p.current?.id === id ? ' is-current' : ''}` },
            h('span', { class: 'music-library__track-number' }, String(tr.number).padStart(2, '0')),
            h('span', { class: 'music-library__track-title' }, tr.title),
            h('span', { class: 'music-library__track-time' }, formatClock(tr.duration)),
          );
          row.addEventListener('click', () => {
            p.playTrack(id);
            list.querySelectorAll('.music-library__track').forEach((x) => x.classList.remove('is-current'));
            row.classList.add('is-current');
          });
          list.append(row);
        }
      }
    }
    const close = () => {
      this.library?.remove();
      this.library = null;
    };
    this.library = h(
      'div',
      { class: 'screen screen--center screen--dim music-library', onclick: (e: Event) => e.target === this.library && close() },
      h(
        'div',
        { class: 'dialog panel', role: 'dialog', 'aria-label': 'Music library' },
        h('h2', { class: 'title dialog__title' }, icon(ListMusic, { size: 22 }), 'Music', h('span', { class: 'dialog__spacer' }), iconBtn(X, 'Close', close, '--small')),
        h('div', { class: 'muted', style: 'font-size:13px' }, 'All music is used under its Creative Commons license. Click a title to play it, or a link to visit its page.'),
        list,
        h('div', { class: 'row' }, btn(ChevronLeft, 'Back', close, '--small')),
      ),
    );
    document.getElementById('ui')!.append(this.library);
  }
}
