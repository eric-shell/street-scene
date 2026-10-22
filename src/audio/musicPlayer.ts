/**
 * Persistent music player. One audio element for the whole app, so music
 * keeps playing across menu, garage, races and drone mode. Every session opens
 * with the same track (OPENING_TRACK_ID, "Astrology") from the top, under the
 * boot splash, and shuffles on from there; volume, mute, shuffle and the
 * minimized state persist in localStorage. Render/UI side only: the simulation
 * never knows music exists.
 */
import catalogJson from '../assets/musicCatalog.json';

export interface MusicTrack {
  id: string;
  title: string;
  number: number;
  file: string;
  duration: number;
  /** Track page on the source site. */
  url: string;
  artist: string;
  artistUrl: string;
  album: string;
  albumShort: string;
  albumUrl: string;
  source: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
}

interface CatalogFile {
  artists: {
    id: string;
    name: string;
    url: string;
    albums: {
      id: string;
      title: string;
      shortTitle: string;
      url: string;
      source: string;
      sourceUrl: string;
      license: string;
      licenseUrl: string;
      tracks: { id: string; title: string; number: number; file: string; duration: number; url: string }[];
    }[];
  }[];
}

export const MUSIC_CATALOG = catalogJson as unknown as CatalogFile;

/** The track every session starts on: the signature tune under the boot splash. */
export const OPENING_TRACK_ID = '1000-handz/electronic-gaming-instrumentals/25';

/** Flatten the catalog (artists -> albums -> tracks) with full credits on every track. */
export function allTracks(catalog: CatalogFile = MUSIC_CATALOG): MusicTrack[] {
  const out: MusicTrack[] = [];
  for (const a of catalog.artists) {
    for (const al of a.albums) {
      for (const t of al.tracks) {
        out.push({
          ...t,
          artist: a.name,
          artistUrl: a.url,
          album: al.title,
          albumShort: al.shortTitle,
          albumUrl: al.url,
          source: al.source,
          sourceUrl: al.sourceUrl,
          license: al.license,
          licenseUrl: al.licenseUrl,
        });
      }
    }
  }
  return out;
}

interface Persisted {
  volume: number;
  muted: boolean;
  shuffle: boolean;
  minimized: boolean;
}

const KEY = 'nightrun.music.v1';
const DEFAULTS: Persisted = { volume: 0.6, muted: false, shuffle: true, minimized: false };
const base = import.meta.env.BASE_URL ?? '/';

export type MusicEvent = 'track' | 'state' | 'time';

export class MusicPlayer {
  readonly tracks: MusicTrack[];
  private audio: HTMLAudioElement;
  private order: number[] = [];
  private pos = 0;
  private s: Persisted;
  private listeners = new Map<MusicEvent, Set<() => void>>();
  /** True once the browser has let us play audibly; before that play() waits for a gesture. */
  private unlocked = false;
  /** Whether music should be playing: on at every session start, off after pause until play. */
  private wantsPlay = true;
  private duck = 1;
  /** Gain over the slider (1 = none): the race session's nitrous swell. */
  private lift = 1;
  private saveTimer = 0;
  private errors = 0;

  constructor(tracks: MusicTrack[] = allTracks()) {
    this.tracks = tracks;
    this.s = this.load();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.buildOrder(this.openingTrack());
    this.applyVolume();
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('timeupdate', () => this.emit('time'));
    this.audio.addEventListener('play', () => this.emit('state'));
    this.audio.addEventListener('pause', () => this.emit('state'));
    this.audio.addEventListener('playing', () => (this.errors = 0));
    this.audio.addEventListener('error', () => {
      // Skip unplayable files, but never loop forever if everything fails.
      if (++this.errors < Math.min(5, this.tracks.length)) this.next();
    });
    if (this.current) this.loadTrack(this.current);
    // Browsers only allow audio after a user gesture: start then if autoplay was refused.
    const unlock = () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('touchend', unlock, true);
      if (this.unlocked && this.playing) return;
      this.unlocked = true;
      if (this.wantsPlay) void this.play();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('touchend', unlock, true);
    window.addEventListener('pagehide', () => this.save());
    void this.autoplay();
    this.setupMediaSession();
  }

  get current(): MusicTrack | null {
    return this.tracks[this.order[this.pos]] ?? null;
  }
  get playing(): boolean {
    return !this.audio.paused;
  }
  /** True while the browser refuses to start music until the user interacts with the page. */
  get blocked(): boolean {
    return this.wantsPlay && !this.unlocked;
  }
  get volume(): number {
    return this.s.volume;
  }
  get muted(): boolean {
    return this.s.muted;
  }
  get shuffle(): boolean {
    return this.s.shuffle;
  }
  get minimized(): boolean {
    return this.s.minimized;
  }
  get time(): number {
    return this.audio.currentTime || 0;
  }
  get duration(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : (this.current?.duration ?? 0);
  }

  on(e: MusicEvent, fn: () => void): () => void {
    let set = this.listeners.get(e);
    if (!set) this.listeners.set(e, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(e: MusicEvent): void {
    this.listeners.get(e)?.forEach((fn) => fn());
  }

  /** The opening track's id, or null (with a warning) when a rebuilt catalog no longer has it. */
  private openingTrack(): string | null {
    if (this.tracks.some((t) => t.id === OPENING_TRACK_ID)) return OPENING_TRACK_ID;
    if (this.tracks.length) console.warn(`Opening track ${OPENING_TRACK_ID} is not in the music catalog; starting on a random track`);
    return null;
  }

  private buildOrder(startId: string | null): void {
    const n = this.tracks.length;
    this.order = Array.from({ length: n }, (_, i) => i);
    if (this.s.shuffle) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      }
    }
    const idx = startId ? this.tracks.findIndex((t) => t.id === startId) : -1;
    if (idx >= 0) {
      // Keep the current track first so toggling shuffle does not jump.
      const at = this.order.indexOf(idx);
      [this.order[0], this.order[at]] = [this.order[at], this.order[0]];
    }
    this.pos = 0;
  }

  private loadTrack(t: MusicTrack): void {
    this.audio.src = base + t.file;
    this.updateMediaSession();
    this.emit('track');
  }

  /**
   * Start music on load. Browsers allow audible autoplay only once the user has
   * interacted with the site (or it has earned their trust), so a refusal just
   * leaves the opening track waiting: the first click, tap or key press starts
   * it from the top rather than joining a silently running track halfway.
   */
  private async autoplay(): Promise<void> {
    if (!this.current) return;
    try {
      await this.audio.play();
      this.unlocked = true;
    } catch {
      /* refused: the first gesture starts it */
    }
    this.emit('state');
  }

  async play(): Promise<void> {
    if (!this.current) return;
    this.wantsPlay = true;
    if (!this.unlocked) return; // will start on the first gesture
    try {
      await this.audio.play();
    } catch {
      /* autoplay blocked; the next gesture retries */
      this.unlocked = false;
    }
    this.emit('state');
  }

  pause(): void {
    this.wantsPlay = false;
    this.audio.pause();
    this.emit('state');
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  next(): void {
    if (!this.tracks.length) return;
    this.pos = (this.pos + 1) % this.order.length;
    this.loadTrack(this.current!);
    if (this.wantsPlay) void this.play();
  }

  prev(): void {
    if (!this.tracks.length) return;
    if (this.audio.currentTime > 4) {
      this.audio.currentTime = 0;
      return;
    }
    this.pos = (this.pos - 1 + this.order.length) % this.order.length;
    this.loadTrack(this.current!);
    if (this.wantsPlay) void this.play();
  }

  playTrack(id: string): void {
    const idx = this.tracks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.pos = this.order.indexOf(idx);
    this.loadTrack(this.tracks[idx]);
    this.unlocked = true;
    void this.play();
  }

  seek(fraction: number): void {
    const d = this.duration;
    if (d > 0) this.audio.currentTime = Math.max(0, Math.min(d - 0.5, fraction * d));
  }

  setVolume(v: number): void {
    this.s.volume = Math.max(0, Math.min(1, v));
    if (this.s.volume > 0) this.s.muted = false;
    this.applyVolume();
    this.scheduleSave();
    this.emit('state');
  }

  setMuted(m: boolean): void {
    this.s.muted = m;
    this.applyVolume();
    this.save();
    this.emit('state');
  }

  setShuffle(on: boolean): void {
    this.s.shuffle = on;
    this.buildOrder(this.current?.id ?? null);
    this.save();
    this.emit('state');
  }

  setMinimized(m: boolean): void {
    this.s.minimized = m;
    this.save();
    this.emit('state');
  }

  /** Temporarily lower the music (e.g. 0.5 while paused in a menu). */
  setDuck(factor: number): void {
    this.duck = Math.max(0, Math.min(1, factor));
    this.applyVolume();
  }

  /**
   * Lift the music over its slider by a gain (1 = none), up to the element's
   * full volume: a swell the caller eases, set every frame (writes only when
   * it moves).
   */
  setLift(gain: number): void {
    const g = Math.max(1, gain);
    if (Math.abs(g - this.lift) < 1e-3 && (g !== 1 || this.lift === 1)) return;
    this.lift = g;
    this.applyVolume();
  }

  private applyVolume(): void {
    // Perceptual curve so the slider feels linear.
    const v = this.s.muted ? 0 : this.s.volume * this.s.volume;
    this.audio.volume = Math.min(1, v * this.duck * this.lift);
  }

  private load(): Persisted {
    const p = { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        // Only the known keys: older versions also stored the track and position.
        const stored = JSON.parse(raw) as Partial<Persisted>;
        if (typeof stored.volume === 'number') p.volume = Math.max(0, Math.min(1, stored.volume));
        if (typeof stored.muted === 'boolean') p.muted = stored.muted;
        if (typeof stored.shuffle === 'boolean') p.shuffle = stored.shuffle;
        if (typeof stored.minimized === 'boolean') p.minimized = stored.minimized;
      }
    } catch {
      /* ignore */
    }
    return p;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.save();
    }, 2000);
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.s));
    } catch {
      /* storage unavailable */
    }
  }

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => void this.play());
    ms.setActionHandler('pause', () => this.pause());
    ms.setActionHandler('nexttrack', () => this.next());
    ms.setActionHandler('previoustrack', () => this.prev());
  }

  private updateMediaSession(): void {
    const t = this.current;
    if (!t || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album });
  }
}
