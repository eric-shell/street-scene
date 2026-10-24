/**
 * Music player UI. Always shows credit for the current track: title, artist,
 * album, source and license, each linked. Modes:
 *  - full: player card (menu, garage, drone); can be minimized to a pill
 *  - compact: races show the minimized pill's twin in the top right, a now-playing chip (controls via M, [ and ])
 *  - hidden
 * A "now playing" banner with full credit appears whenever the track changes.
 * Styled by _music-player.scss and, for the library dialog, _music-library.scss.
 *
 * Every screen's help button stands just left of whichever piece is on show
 * (card, pill or chip), so the two persistent corners read as one: the widget
 * publishes that piece's place as `--help-right` and `--help-bottom` (or
 * `--help-top` with `body.is-music-top` for the race's chip up top) on the
 * document, read by panels/_help.scss. Only on changes (mode, track, size,
 * resize), never per frame.
 */
import { MUSIC_CATALOG, type MusicPlayer, type MusicTrack } from '../../audio/musicPlayer';
import { btn, h, iconBtn, isTyping, link } from '../kit/dom';
import { ChevronLeft, Disc3, ListMusic, Minimize2, Music, Pause, Play, Shuffle, SkipBack, SkipForward, Volume2, VolumeX, X, icon } from '../kit/icons';
import { formatClock } from '../kit/format';

export type MusicMode = 'full' | 'compact' | 'hidden';

/** "Title" by Artist · Album · Source · License, all linked. */
function creditLine(t: MusicTrack): HTMLElement {
  return h(
    'span',
    { class: 'music-player__credit' },
    link(t.url, `"${t.title}"`),
    ' by ',
    link(t.artistUrl, t.artist),
    ' · ',
    link(t.albumUrl, t.albumShort),
    ' · ',
    link(t.sourceUrl, t.source),
    ' · ',
    link(t.licenseUrl, t.license),
  );
}

export class MusicWidget {
  private root: HTMLElement;
  private card: HTMLElement;
  private pill: HTMLButtonElement;
  private chip: HTMLElement;
  private banner: HTMLElement;
  private library: HTMLElement | null = null;
  private titleEl: HTMLElement;
  private artistEl: HTMLElement;
  private creditEl: HTMLElement;
  private fill: HTMLElement;
  private timeEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private shuffleBtn: HTMLButtonElement;
  private vol: HTMLInputElement;
  private disc: HTMLElement;
  private mode: MusicMode = 'hidden';
  private bannerTimer = 0;
  private lastTrack: string | null = null;

  constructor(
    parent: HTMLElement,
    private readonly player: MusicPlayer,
  ) {
    this.titleEl = h('div', { class: 'music-player__title' });
    this.artistEl = h('div', { class: 'music-player__artist' });
    this.creditEl = h('div', { class: 'music-player__credits' });
    this.fill = h('div', { class: 'music-player__fill' });
    this.timeEl = h('div', { class: 'music-player__time' });
    const bar = h('div', { class: 'music-player__bar', role: 'slider', 'aria-label': 'Seek' }, this.fill);
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      player.seek((e.clientX - r.left) / r.width);
    });
    this.playBtn = iconBtn(Play, 'Play', () => player.toggle(), '--small music-player__play');
    this.muteBtn = iconBtn(Volume2, 'Mute', () => player.setMuted(!player.muted), '--small');
    this.shuffleBtn = iconBtn(Shuffle, 'Shuffle', () => player.setShuffle(!player.shuffle), '--small');
    this.vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': 'Music volume', class: 'music-player__volume' }) as HTMLInputElement;
    this.vol.addEventListener('input', () => player.setVolume(Number(this.vol.value)));
    this.disc = h('div', { class: 'music-player__disc' }, icon(Disc3, { size: 30 }));
    this.card = h(
      'div',
      { class: 'music-player__card panel', role: 'region', 'aria-label': 'Music player' },
      h(
        'div',
        { class: 'music-player__head' },
        this.disc,
        h('div', { class: 'music-player__meta' }, this.titleEl, this.artistEl),
        iconBtn(ListMusic, 'Music library', () => this.openLibrary(), '--small'),
        iconBtn(Minimize2, 'Minimize player', () => player.setMinimized(true), '--small'),
      ),
      h('div', { class: 'music-player__progress' }, bar, this.timeEl),
      h(
        'div',
        { class: 'music-player__controls' },
        this.shuffleBtn,
        iconBtn(SkipBack, 'Previous track', () => player.prev(), '--small'),
        this.playBtn,
        iconBtn(SkipForward, 'Next track', () => player.next(), '--small'),
        this.muteBtn,
        this.vol,
      ),
      this.creditEl,
    );
    this.pill = h('button', { class: 'music-player__pill panel', type: 'button', 'aria-label': 'Show music player' }) as HTMLButtonElement;
    this.pill.addEventListener('click', () => player.setMinimized(false));
    this.chip = h('div', { class: 'music-player__chip panel', role: 'status', 'aria-label': 'Now playing' });
    this.banner = h('div', { class: 'music-player__banner panel', 'aria-live': 'polite' });
    this.root = h('div', { class: 'music-player' }, this.card, this.pill, this.chip, this.banner);
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

  setMode(mode: MusicMode, context: 'menu' | 'garage' | 'drone' | 'race' = 'menu'): void {
    this.mode = mode;
    this.root.dataset.context = context;
    this.render();
  }

  /** Publish where the piece on show stands, for the help buttons beside it; nothing on show leaves them their corner. */
  private dock(): void {
    const style = document.documentElement.style;
    const el = [this.card, this.pill, this.chip].find((x) => x.getClientRects().length > 0);
    const r = el?.getBoundingClientRect();
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
    this.showBanner(t);
  }

  private showBanner(t: MusicTrack): void {
    if (this.mode === 'hidden') return;
    this.banner.replaceChildren(
      h('div', { class: 'music-player__banner-label' }, icon(Music, { size: 14 }), 'Now playing'),
      h('div', { class: 'music-player__banner-title' }, t.title),
      h('div', { class: 'music-player__banner-artist' }, t.artist),
      creditLine(t),
    );
    this.banner.classList.remove('is-visible');
    void this.banner.offsetWidth;
    this.banner.classList.add('is-visible');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('is-visible'), 5000);
  }

  private render(): void {
    const p = this.player;
    const t = p.current;
    const full = this.mode === 'full';
    this.root.dataset.mode = this.mode;
    this.card.style.display = full && !p.minimized ? '' : 'none';
    this.pill.style.display = full && p.minimized ? '' : 'none';
    this.chip.style.display = this.mode === 'compact' && t ? '' : 'none';
    // A mode or screen can move the piece on show without resizing it (the observer catches the rest).
    this.dock();
    if (!t) {
      this.titleEl.textContent = 'No music installed';
      this.artistEl.textContent = 'Run npm run music';
      return;
    }
    this.titleEl.textContent = t.title;
    this.titleEl.title = t.title;
    this.artistEl.textContent = `${t.artist} · ${t.albumShort}`;
    this.creditEl.replaceChildren(creditLine(t));
    this.playBtn.replaceChildren(icon(p.playing ? Pause : Play, { size: 18 }));
    this.playBtn.setAttribute('aria-label', p.playing ? 'Pause' : 'Play');
    this.muteBtn.replaceChildren(icon(p.muted || p.volume === 0 ? VolumeX : Volume2, { size: 18 }));
    this.shuffleBtn.classList.toggle('btn--primary', p.shuffle);
    this.vol.value = String(p.muted ? 0 : p.volume);
    this.disc.classList.toggle('is-spinning', p.playing);
    // The race's chip is the pill to the letter (muted shows as such, since only M can unmute it there).
    const pillIcon = () => icon(p.muted ? VolumeX : p.playing ? Disc3 : Music, { size: 18, className: p.playing && !p.muted ? 'is-spinning' : '' });
    this.pill.replaceChildren(pillIcon(), h('span', { class: 'music-player__pill-label' }, t.title));
    this.chip.replaceChildren(pillIcon(), h('span', { class: 'music-player__pill-label' }, t.title));
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
    this.banner.classList.remove('is-visible');
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

/** Music credits block for the credits screen. */
export function musicCredits(): HTMLElement {
  const wrap = h('div', { class: 'music-player__credits-block' });
  for (const artist of MUSIC_CATALOG.artists) {
    for (const album of artist.albums) {
      const details = h('details', {}, h('summary', {}, `${album.tracks.length} tracks`));
      const ol = h('ol', { class: 'music-player__credits-tracks' });
      for (const t of album.tracks) ol.append(h('li', { value: t.number }, link(t.url, t.title)));
      details.append(ol);
      wrap.append(
        h(
          'p',
          {},
          'Music: ',
          link(album.url, `"${album.title}"`),
          ' by ',
          link(artist.url, artist.name),
          ', from ',
          link(album.sourceUrl, album.source),
          ', licensed under ',
          link(album.licenseUrl, album.license),
          '. Transcoded to 128 kbps and loudness normalized; otherwise unmodified.',
        ),
        details,
      );
    }
  }
  return wrap;
}
