/**
 * A Lucide icon as React SVG, drawn from the same vanilla `lucide` icon nodes the game uses (ui/kit/icons.ts),
 * so the dashboard adds no second icon package and every glyph matches the game's exactly. Decorative unless a
 * `label` is given, and the `.icon` class the kit styles.
 */
import { createElement } from 'react';
import type { IconNode } from 'lucide';

const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function Icon({ node, size = 16, strokeWidth = 2, label, className }: { node: IconNode; size?: number; strokeWidth?: number; label?: string; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon ${className}` : 'icon'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {node.map(([tag, attrs], i) => createElement(tag, { key: i, ...Object.fromEntries(Object.entries(attrs).map(([k, v]) => [camel(k), v])) }))}
    </svg>
  );
}
