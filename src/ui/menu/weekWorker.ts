/**
 * The This Week step's planner thread (weekPlanner.ts): plans a seed's roads and event (weekThumb.ts, about
 * 300 ms each) and draws its thumbnail on an OffscreenCanvas, so seven cities never stall the menu behind
 * them. It answers every request in order with the summary and the thumbnail, transferred as an ImageBitmap.
 */
import { THUMB_H, THUMB_W, planDay, type DaySummary } from './weekThumb';

export interface WeekRequest {
  seed: string;
  dpr: number;
}

export type WeekReply = { ok: true; summary: DaySummary } | { ok: false; seed: string };

const post = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void };

addEventListener('message', (e: MessageEvent<WeekRequest>) => {
  const { seed, dpr } = e.data;
  try {
    const day = planDay(seed);
    const canvas = new OffscreenCanvas(Math.round(THUMB_W * dpr), Math.round(THUMB_H * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    day.draw(ctx, dpr);
    const thumb = canvas.transferToImageBitmap();
    const reply: WeekReply = { ok: true, summary: { ...day.summary, thumb, dpr } };
    post.postMessage(reply, [thumb]);
  } catch {
    const reply: WeekReply = { ok: false, seed };
    post.postMessage(reply);
  }
});
