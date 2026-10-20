/**
 * Music player UI. Always shows credit for the current track: title, artist,
 * album, source and license, each linked. Modes:
 *  - full: player card (menu, garage, drone); can be minimized to a pill
 *  - compact: a now-playing chip for races (controls via M, [ and ])
 *  - hidden
 * A "now playing" banner with full credit appears whenever the track changes.
 */
import { MusicPlayer, MusicTrack, MUSIC_CATALOG } from '../audio/musicPlayer';
import { h, iconBtn } from './dom';
import { ChevronLeft, Disc3, ListMusic, Minimize2, Music, Pause, Play, Shuffle, SkipBack, SkipForward, Volume2, VolumeX, X, icon } from './icons';
import { formatTime } from './format';

export type MusicMode = 'full' | 'compact' | 'hidden';

const link = (href: string, text: string, cls = '') => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);

/** "Title" by Artist · Album · Source · License, all linked. */
export function creditLine(t: MusicTrack): HTMLElement {
  return h(
    'span',
    { class: 'mw-credit' },
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
    this.titleEl = h('div', { class: 'mw-title' });
    this.artistEl = h('div', { class: 'mw-artist' });
    this.creditEl = h('div', { class: 'mw-credits' });
    this.fill = h('div', { class: 'mw-fill' });
    this.timeEl = h('div', { class: 'mw-time' });
    const bar = h('div', { class: 'mw-bar', role: 'slider', 'aria-label': 'Seek' }, this.fill);
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      player.seek((e.clientX - r.left) / r.width);
    });
    this.playBtn = iconBtn(Play, 'Play', () => player.toggle(), 'small mw-play');
    this.muteBtn = iconBtn(Volume2, 'Mute', () => player.setMuted(!player.muted), 'small');
    this.shuffleBtn = iconBtn(Shuffle, 'Shuffle', () => player.setShuffle(!player.shuffle), 'small');
    this.vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': 'Music volume', class: 'mw-vol' }) as HTMLInputElement;
    this.vol.addEventListener('input', () => player.setVolume(Number(this.vol.value)));
    this.disc = h('div', { class: 'mw-disc' }, icon(Disc3, { size: 30 }));
    this.card = h(
      'div',
      { class: 'mw-card panel', role: 'region', 'aria-label': 'Music player' },
      h(
        'div',
        { class: 'mw-head' },
        this.disc,
        h('div', { class: 'mw-meta' }, this.titleEl, this.artistEl),
        iconBtn(ListMusic, 'Music library', () => this.openLibrary(), 'small'),
        iconBtn(Minimize2, 'Minimize player', () => player.setMinimized(true), 'small'),
      ),
      h('div', { class: 'mw-progress' }, bar, this.timeEl),
      h(
        'div',
        { class: 'mw-controls' },
        this.shuffleBtn,
        iconBtn(SkipBack, 'Previous track', () => player.prev(), 'small'),
        this.playBtn,
        iconBtn(SkipForward, 'Next track', () => player.next(), 'small'),
        this.muteBtn,
        this.vol,
      ),
      this.creditEl,
    );
    this.pill = h('button', { class: 'mw-pill panel', type: 'button', 'aria-label': 'Show music player' }) as HTMLButtonElement;
    this.pill.addEventListener('click', () => player.setMinimized(false));
    this.chip = h('div', { class: 'mw-chip' });
    this.banner = h('div', { class: 'mw-banner panel', 'aria-live': 'polite' });
    this.root = h('div', { class: 'mw' }, this.card, this.pill, this.chip, this.banner);
    parent.append(this.root);

    player.on('track', () => this.onTrack());
    player.on('state', () => this.render());
    player.on('time', () => this.renderTime());
    window.addEventListener('keydown', (e) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT')) return;
      if (e.code === 'KeyM' && !e.repeat) player.setMuted(!player.muted);
      else if (e.code === 'BracketRight' && !e.repeat) player.next();
      else if (e.code === 'BracketLeft' && !e.repeat) player.prev();
    });
    // Phones start minimized so the player never covers controls.
    if (window.matchMedia('(max-width: 720px), (max-height: 500px)').matches && !player.minimized) player.setMinimized(true);
    this.onTrack(true);
  }

  setMode(mode: MusicMode): void {
    this.mode = mode;
    this.render();
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
      h('div', { class: 'mw-banner-label' }, icon(Music, { size: 14 }), 'Now playing'),
      h('div', { class: 'mw-banner-title' }, t.title),
      h('div', { class: 'mw-banner-artist' }, t.artist),
      creditLine(t),
    );
    this.banner.classList.remove('show');
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('show'), 5000);
  }

  private render(): void {
    const p = this.player;
    const t = p.current;
    const full = this.mode === 'full';
    this.root.dataset.mode = this.mode;
    this.card.style.display = full && !p.minimized ? '' : 'none';
    this.pill.style.display = full && p.minimized ? '' : 'none';
    this.chip.style.display = this.mode === 'compact' && t ? '' : 'none';
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
    this.shuffleBtn.classList.toggle('primary', p.shuffle);
    this.vol.value = String(p.muted ? 0 : p.volume);
    this.disc.classList.toggle('spin', p.playing);
    this.pill.replaceChildren(icon(p.playing ? Disc3 : Music, { size: 18, className: p.playing ? 'spin' : '' }), h('span', {}, t.title));
    this.chip.replaceChildren(icon(p.muted ? VolumeX : Music, { size: 14 }), h('span', {}, `${t.title} — ${t.artist}`));
    this.renderTime();
  }

  private renderTime(): void {
    const p = this.player;
    const d = p.duration;
    this.fill.style.width = d > 0 ? `${(p.time / d) * 100}%` : '0';
    this.timeEl.textContent = `${formatTime(p.time).slice(0, -3)} / ${formatTime(d).slice(0, -3)}`;
  }

  /** Library: every artist, album and track with full credits. */
  openLibrary(): void {
    this.library?.remove();
    this.banner.classList.remove('show');
    const p = this.player;
    const list = h('div', { class: 'mw-lib-list' });
    for (const artist of MUSIC_CATALOG.artists) {
      for (const album of artist.albums) {
        list.append(
          h(
            'div',
            { class: 'mw-lib-album' },
            h('div', { class: 'mw-lib-album-title' }, link(album.url, album.title)),
            h(
              'div',
              { class: 'muted mw-lib-album-credit' },
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
            { type: 'button', class: `mw-lib-track${p.current?.id === id ? ' on' : ''}` },
            h('span', { class: 'n' }, String(tr.number).padStart(2, '0')),
            h('span', { class: 't' }, tr.title),
            h('span', { class: 'd' }, formatTime(tr.duration).slice(0, -3)),
          );
          row.addEventListener('click', () => {
            p.playTrack(id);
            list.querySelectorAll('.mw-lib-track').forEach((x) => x.classList.remove('on'));
            row.classList.add('on');
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
      { class: 'screen center dim mw-lib', onclick: (e: Event) => e.target === this.library && close() },
      h(
        'div',
        { class: 'dialog panel', role: 'dialog', 'aria-label': 'Music library' },
        h('h2', { class: 'title' }, icon(ListMusic, { size: 22 }), 'Music', h('span', { style: 'flex:1' }), iconBtn(X, 'Close', close, 'small')),
        h('div', { class: 'muted', style: 'font-size:13px' }, 'All music is used under its Creative Commons license. Click a title to play it, or a link to visit its page.'),
        list,
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onclick: close }, icon(ChevronLeft, { size: 16 }), 'Back')),
      ),
    );
    document.getElementById('ui')!.append(this.library);
  }
}

/** Music credits block for the credits screen. */
export function musicCredits(): HTMLElement {
  const wrap = h('div', { class: 'mw-credits-block' });
  for (const artist of MUSIC_CATALOG.artists) {
    for (const album of artist.albums) {
      const details = h('details', {}, h('summary', {}, `${album.tracks.length} tracks`));
      const ol = h('ol', { class: 'mw-credits-tracks' });
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
