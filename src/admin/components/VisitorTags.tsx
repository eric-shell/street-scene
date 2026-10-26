/**
 * A row's traffic tags (lib/classify.ts): every tag pairs an icon with a word, never color alone (red beside
 * yellow is the classic color-blind confusion pair), and carries the classifier's reason as a title, since a
 * judgement the reader cannot interrogate is worse than none.
 */
import { Bot, CarFront, CircleUser, EyeOff, FlagTriangleRight, FlaskConical, Footprints, Globe, Hourglass, MoonStar, RotateCcw, Sparkles, VenetianMask, Waypoints, Wrench, type IconNode } from 'lucide';
import type { VisitorTag } from '../lib/classify';
import { Icon } from './Icon';

const ICON: Record<string, IconNode> = {
  Bot: Bot,
  Headless: Bot,
  // Traffic we made ourselves reads differently from a stranger's crawler at a glance.
  Test: FlaskConical,
  LLM: Sparkles,
  // Caught claiming to be something it is not, rather than announcing itself.
  Spoofed: VenetianMask,
  'No dwell': MoonStar,
  Bounce: MoonStar,
  // Both about where the traffic came through, not what it did; one lands on ordinary people.
  Proxy: Waypoints,
  Burst: Waypoints,
  'VPN?': Globe,
  Returning: RotateCcw,
  Finished: FlagTriangleRight,
  Raced: CarFront,
  Garage: Wrench,
  'Signed in': CircleUser,
  Lingered: Hourglass,
  Skimmed: Footprints,
  Untracked: EyeOff,
};

export function VisitorTags({ tags, under }: { tags: VisitorTag[]; under?: boolean }) {
  if (tags.length === 0) return null;
  return (
    <span className={under ? 'visitor-tags visitor-tags--under' : 'visitor-tags'}>
      {tags.map((t) => (
        <span key={t.label} title={t.reason} className={`visitor-tag visitor-tag--${t.tone}`}>
          <Icon node={ICON[t.label] ?? Bot} size={11} strokeWidth={2.5} />
          {t.label}
        </span>
      ))}
    </span>
  );
}
