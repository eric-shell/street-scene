/**
 * Persistent music player. One audio element for the whole app, so music
 * keeps playing across menu, garage, races and drone mode. Track, position,
 * volume, shuffle and play state persist in localStorage and resume on reload.
 * Render/UI side only: the simulation never knows music exists.
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
  trackId: string | null;
  time: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  playing: boolean;
  minimized: boolean;
}

const KEY = 'nightrun.music.v1';
const DEFAULTS: Persisted = { trackId: null, time: 0, volume: 0.6, muted: false, shuffle: true, playing: true, minimized: false };
const base = import.meta.env.BASE_URL ?? '/';

export type MusicEvent = 'track' | 'state' | 'time';

export class MusicPlayer {
  readonly tracks: MusicTrack[];
  private audio: HTMLAudioElement;
  private order: number[] = [];
  private pos = 0;
  private s: Persisted;
  private listeners = new Map<MusicEvent, Set<() => void>>();
  private unlocked = false;
  private duck = 1;
  private saveTimer = 0;
  private errors = 0;

  constructor(tracks: MusicTrack[] = allTracks()) {
    this.tracks = tracks;
    this.s = this.load();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.buildOrder(this.s.trackId);
    this.applyVolume();
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('timeupdate', () => {
      this.emit('time');
      this.scheduleSave();
    });
    this.audio.addEventListener('play', () => this.emit('state'));
    this.audio.addEventListener('pause', () => this.emit('state'));
    this.audio.addEventListener('playing', () => (this.errors = 0));
    this.audio.addEventListener('error', () => {
      // Skip unplayable files, but never loop forever if everything fails.
      if (++this.errors < Math.min(5, this.tracks.length)) this.next();
    });
    if (this.current) this.loadTrack(this.current, this.s.time);
    // Browsers only allow audio after a user gesture: start then if music was on.
    const unlock = () => {
      if (this.unlocked) return;
      this.unlocked = true;
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      if (this.s.playing) void this.play();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('pagehide', () => this.save());
    this.setupMediaSession();
  }

  get current(): MusicTrack | null {
    return this.tracks[this.order[this.pos]] ?? null;
  }
  get playing(): boolean {
    return !this.audio.paused;
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

  private loadTrack(t: MusicTrack, startAt = 0): void {
    this.audio.src = base + t.file;
    if (startAt > 0) {
      const seek = () => {
        if (startAt < this.audio.duration - 2) this.audio.currentTime = startAt;
      };
      this.audio.addEventListener('loadedmetadata', seek, { once: true });
    }
    this.s.trackId = t.id;
    this.updateMediaSession();
    this.emit('track');
    this.save();
  }

  async play(): Promise<void> {
    if (!this.current) return;
    this.s.playing = true;
    this.save();
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
    this.s.playing = false;
    this.audio.pause();
    this.save();
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
    if (this.s.playing) void this.play();
  }

  prev(): void {
    if (!this.tracks.length) return;
    if (this.audio.currentTime > 4) {
      this.audio.currentTime = 0;
      return;
    }
    this.pos = (this.pos - 1 + this.order.length) % this.order.length;
    this.loadTrack(this.current!);
    if (this.s.playing) void this.play();
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

  private applyVolume(): void {
    // Perceptual curve so the slider feels linear.
    const v = this.s.muted ? 0 : this.s.volume * this.s.volume;
    this.audio.volume = v * this.duck;
  }

  private load(): Persisted {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) };
        p.volume = Math.max(0, Math.min(1, Number(p.volume) || 0));
        p.time = Math.max(0, Number(p.time) || 0);
        return p;
      }
    } catch {
      /* ignore */
    }
    return { ...DEFAULTS };
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.save();
    }, 2000);
  }

  private save(): void {
    this.s.time = this.audio?.currentTime || 0;
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
