/**
 * The title lockup's words, shared by the menu and the boot splash. Its own module so the splash, which boot.ts
 * shows before the game's bundle has loaded, does not pull the menu (and through it the sim and city) in with it.
 */
import { h } from '../kit/dom';

/** The title's words: one line, sized to the menu's column in the menu and on the splash alike (`.title-lockup__title .logo` in _title-lockup.scss). */
export const TITLE_WORDS = ['STREET', 'SCENE'] as const;
export const TAGLINE = 'midnight street racing club';

/** The title's words as spans, with a space between so its text reads "STREET SCENE"; the splash fills them letter by letter. */
export function titleWords(word: (text: string) => (Node | string)[] = (t) => [t]): (Node | string)[] {
  return TITLE_WORDS.flatMap((t, i) => [...(i ? [' '] : []), h('span', { class: 'logo__word' }, ...word(t))]);
}
