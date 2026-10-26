/**
 * The card every insight chart sits in: one plate, one figure, one caption row (a single-series chart gets its
 * identity from the caption; a one-swatch legend would only restate it). `min-width: 0` on the card is
 * load-bearing (_chart-frame.scss says why). The frame never fixes a height, so a card grows to hold its axis
 * rather than clipping it into a nested scrollbar.
 */
import type { ReactNode } from 'react';

export function ChartFrame({ title, meta, children, className }: { title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <figure className={className ? `chart-card ${className}` : 'chart-card'}>
      <figcaption className="chart-card__caption">
        <span className="chart-card__title">{title}</span>
        {meta !== undefined ? <span className="chart-card__meta">{meta}</span> : null}
      </figcaption>
      {children}
    </figure>
  );
}

/** A chart with nothing to draw says which measurement is missing, so an empty card never looks broken. */
export function ChartEmpty({ children }: { children: ReactNode }) {
  return <p className="chart-empty">{children}</p>;
}
