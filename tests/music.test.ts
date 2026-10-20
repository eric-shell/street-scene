import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import catalog from '../src/assets/musicCatalog.json';
import { OPENING_TRACK_ID, allTracks } from '../src/audio/musicPlayer';

describe('music catalog', () => {
  it('every track has its audio file and full attribution', () => {
    expect(catalog.artists.length).toBeGreaterThan(0);
    let tracks = 0;
    for (const artist of catalog.artists) {
      expect(artist.name).toBeTruthy();
      expect(artist.url).toMatch(/^https:\/\//);
      for (const album of artist.albums) {
        expect(album.title).toBeTruthy();
        expect(album.source).toBeTruthy();
        expect(album.sourceUrl).toMatch(/^https:\/\//);
        expect(album.license).toMatch(/^CC /);
        expect(album.licenseUrl).toMatch(/^https:\/\/creativecommons\.org\/licenses\//);
        for (const t of album.tracks) {
          tracks++;
          expect(t.title).toBeTruthy();
          expect(t.url).toMatch(/^https:\/\//);
          expect(t.duration).toBeGreaterThan(10);
          const file = join(process.cwd(), 'public', t.file);
          expect(existsSync(file), file).toBe(true);
          expect(statSync(file).size).toBeGreaterThan(50_000);
        }
      }
    }
    expect(tracks).toBeGreaterThanOrEqual(42);
  });

  it('has the opening track every session starts on', () => {
    // A rebuilt catalog (npm run music) must still contain it, or the splash plays over a random track.
    const opening = allTracks().find((t) => t.id === OPENING_TRACK_ID);
    expect(opening?.title).toBe('Astrology');
  });
});
