/**
 * The dashboard's toasts: a tiny store the Toaster component renders, in the kit's `.toast` (ui/kit/_toast.scss
 * rises, holds and fades on its own). A store rather than the kit's DOM `toast()` so React owns every node on
 * the page; the look is the game's.
 */
export type ToastTone = 'success' | 'error';

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

/** How long a toast stays mounted (ms): the kit's 2.6 s animation, plus a beat. */
export const TOAST_MS = 2700;

let next = 1;
let items: ToastItem[] = [];
const listeners = new Set<(items: ToastItem[]) => void>();

function push(text: string, tone: ToastTone): void {
  const item = { id: next++, text, tone };
  items = [...items, item];
  for (const fn of listeners) fn(items);
  setTimeout(() => {
    items = items.filter((t) => t.id !== item.id);
    for (const fn of listeners) fn(items);
  }, TOAST_MS);
}

export const toast = {
  success: (text: string) => push(text, 'success'),
  error: (text: string) => push(text, 'error'),
};

/** Calls `fn` with the live toasts on every change; returns the unsubscribe. */
export function onToasts(fn: (items: ToastItem[]) => void): () => void {
  listeners.add(fn);
  fn(items);
  return () => void listeners.delete(fn);
}
