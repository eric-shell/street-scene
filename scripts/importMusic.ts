/**
 * Music import: `npm run music [-- --album <album dir> --source <folder of mp3s>]`
 *
 * Library layout (one folder per artist, one per album):
 *
 *   assets/music/<artist-slug>/<album-slug>/album.json   credits + track list (hand authored)
 *   public/music/<artist-slug>/<album-slug>/NN-<track>.mp3  web audio (generated)
 *   src/assets/musicCatalog.json                         catalog the game reads (generated)
 *
 * With --album and --source, every track in album.json is matched to a source
 * file by its leading track number ("01 Artist - Title.mp3"), then transcoded
 * with ffmpeg to 128 kbps MP3 with loudness normalization. Without arguments
 * the catalog is just rebuilt from every album.json and the files present.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

interface AlbumTrack {
  number: number;
  title: string;
  url: string;
}

interface AlbumMeta {
  artist: string;
  artistUrl: string;
  album: string;
  albumShort?: string;
  albumUrl: string;
  released?: string;
  source: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  notes?: string;
  tracks: AlbumTrack[];
}

const ROOT = process.cwd();
const LIB = join(ROOT, 'assets/music');
const OUT = join(ROOT, 'public/music');
const CATALOG = join(ROOT, 'src/assets/musicCatalog.json');
const BITRATE = '128k';

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function expand(p: string): string {
  return resolve(p.replace(/^~(?=$|\/)/, homedir()));
}

function duration(file: string): number {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
    return Math.round(Number(out.trim()) * 10) / 10;
  } catch {
    return 0;
  }
}

function trackFile(t: AlbumTrack): string {
  return `${String(t.number).padStart(2, '0')}-${slugify(t.title)}.mp3`;
}

function importAlbum(albumDir: string, sourceDir: string): void {
  const meta = JSON.parse(readFileSync(join(albumDir, 'album.json'), 'utf8')) as AlbumMeta;
  const rel = relative(LIB, albumDir);
  const outDir = join(OUT, rel);
  mkdirSync(outDir, { recursive: true });
  const sources = readdirSync(sourceDir).filter((f) => /\.(mp3|wav|flac|ogg|m4a)$/i.test(f));
  for (const t of meta.tracks) {
    const src = sources.find((f) => {
      const m = f.match(/^(\d+)/);
      return m && Number(m[1]) === t.number;
    });
    if (!src) throw new Error(`No source file for track ${t.number} "${t.title}" in ${sourceDir}`);
    const dst = join(outDir, trackFile(t));
    if (existsSync(dst) && statSync(dst).mtimeMs > statSync(join(sourceDir, src)).mtimeMs) continue;
    console.log(`  ${src} -> ${relative(ROOT, dst)}`);
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        join(sourceDir, src),
        '-vn',
        '-map_metadata',
        '-1',
        '-af',
        'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-ar',
        '44100',
        '-codec:a',
        'libmp3lame',
        '-b:a',
        BITRATE,
        // Credit travels with the file too.
        '-metadata',
        `title=${t.title}`,
        '-metadata',
        `artist=${meta.artist}`,
        '-metadata',
        `album=${meta.album}`,
        '-metadata',
        `track=${t.number}`,
        '-metadata',
        `copyright=${meta.license} (${meta.licenseUrl}) via ${meta.source}`,
        dst,
      ],
      { stdio: 'inherit' },
    );
  }
}

interface CatalogTrack {
  id: string;
  title: string;
  number: number;
  file: string;
  duration: number;
  url: string;
}

interface CatalogAlbum {
  id: string;
  title: string;
  shortTitle: string;
  url: string;
  released?: string;
  source: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  tracks: CatalogTrack[];
}

interface CatalogArtist {
  id: string;
  name: string;
  url: string;
  albums: CatalogAlbum[];
}

function buildCatalog(): { artists: CatalogArtist[] } {
  const artists: CatalogArtist[] = [];
  if (!existsSync(LIB)) return { artists };
  for (const artistSlug of readdirSync(LIB).sort()) {
    const artistDir = join(LIB, artistSlug);
    if (!statSync(artistDir).isDirectory()) continue;
    let artist: CatalogArtist | null = null;
    for (const albumSlug of readdirSync(artistDir).sort()) {
      const metaPath = join(artistDir, albumSlug, 'album.json');
      if (!existsSync(metaPath)) continue;
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as AlbumMeta;
      artist ??= { id: artistSlug, name: meta.artist, url: meta.artistUrl, albums: [] };
      const tracks: CatalogTrack[] = [];
      for (const t of meta.tracks) {
        const file = `music/${artistSlug}/${albumSlug}/${trackFile(t)}`;
        const abs = join(ROOT, 'public', file);
        if (!existsSync(abs)) {
          console.warn(`  missing audio for ${meta.artist} - ${t.title} (${file}); skipped`);
          continue;
        }
        tracks.push({ id: `${artistSlug}/${albumSlug}/${t.number}`, title: t.title, number: t.number, file, duration: duration(abs), url: t.url });
      }
      artist.albums.push({
        id: `${artistSlug}/${albumSlug}`,
        title: meta.album,
        shortTitle: meta.albumShort ?? meta.album,
        url: meta.albumUrl,
        released: meta.released,
        source: meta.source,
        sourceUrl: meta.sourceUrl,
        license: meta.license,
        licenseUrl: meta.licenseUrl,
        tracks,
      });
    }
    if (artist) artists.push(artist);
  }
  return { artists };
}

function main(): void {
  const album = arg('album');
  const source = arg('source');
  if (album || source) {
    if (!album || !source) throw new Error('Use both --album <assets/music/artist/album> and --source <folder>');
    const albumDir = expand(album);
    console.log(`Importing ${basename(albumDir)} from ${source}`);
    importAlbum(albumDir, expand(source));
  }
  const catalog = buildCatalog();
  writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + '\n');
  const n = catalog.artists.reduce((s, a) => s + a.albums.reduce((t, b) => t + b.tracks.length, 0), 0);
  console.log(`music catalog: ${catalog.artists.length} artist(s), ${n} track(s) -> ${relative(ROOT, CATALOG)}`);
}

main();
