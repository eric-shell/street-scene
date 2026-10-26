/**
 * Race modes: one row per race type, in the menu's order, each in the type's own color (palette.$modes) with
 * its icon and name, so a mode is never named by color alone (the mode colors fail the dark lightness band as a
 * categorical set; chartTheme.ts has the validation). Small multiples rather than one legend-keyed chart: each
 * row is its own bar of starts, split into finished (solid), quit (hatched: a texture, so the split survives
 * any color vision) and the rest (starts whose end was never recorded, a closed tab that sent no beacon). Bar
 * length is starts against the busiest mode. Median finish time and the visitor count close the row.
 */
import type { ModeRow } from '../../../api/_lib/adminTypes';
import { ChartEmpty } from '../components/ChartFrame';
import { Icon } from '../components/Icon';
import { formatRaceTime } from '../lib/dateFormat';
import { MODES, MODE_ORDER, isMode, modeLabel } from '../lib/gameVocab';

function order(rows: ModeRow[]): ModeRow[] {
  const rank = (m: string) => (isMode(m) ? MODE_ORDER.indexOf(m) : MODE_ORDER.length);
  return [...rows].sort((a, b) => rank(a.mode) - rank(b.mode) || b.starts - a.starts);
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

export function ModeChart({ modes }: { modes: ModeRow[] }) {
  const rows = order(modes.filter((m) => m.starts > 0));
  if (rows.length === 0) return <ChartEmpty>No races or free roams started in this window.</ChartEmpty>;
  const max = Math.max(...rows.map((r) => r.starts), 1);
  return (
    <>
      <ul className="mode-chart" aria-hidden="true">
        {rows.map((r) => {
          const finished = Math.min(r.finishes, r.starts);
          const quit = Math.min(r.quits, r.starts - finished);
          return (
            // The theme class (base/_tokens.scss .mode-*) sets --mode, as on every race type in the game.
            <li key={r.mode} className={isMode(r.mode) ? `mode-chart__row mode-${r.mode}` : 'mode-chart__row'}>
              <span className="mode-chart__head">
                <span className="mode-chart__name">
                  {isMode(r.mode) ? <Icon node={MODES[r.mode].icon} size={14} /> : null}
                  {modeLabel(r.mode)}
                </span>
                <span className="mode-chart__starts">
                  {plural(r.starts, 'start')} <span className="mode-chart__dim">· {plural(r.visitors, 'visitor')}</span>
                </span>
              </span>
              <span className="mode-chart__track" style={{ width: `${(r.starts / max) * 100}%` }}>
                {finished > 0 ? <span className="mode-chart__finished" style={{ flexGrow: finished }} /> : null}
                {quit > 0 ? <span className="mode-chart__quit" style={{ flexGrow: quit }} /> : null}
                {r.starts - finished - quit > 0 ? <span className="mode-chart__open" style={{ flexGrow: r.starts - finished - quit }} /> : null}
              </span>
              <span className="mode-chart__stats">
                {r.mode === 'roam' ? `${r.quits} left` : `${r.finishes} finished · ${r.quits} quit`}
                {r.medianTimeMs !== null ? <span className="mode-chart__time">median {formatRaceTime(r.medianTimeMs)}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mode-chart__legend" aria-hidden="true">
        <span className="mode-chart__key mode-chart__key--finished" /> finished
        <span className="mode-chart__key mode-chart__key--quit" /> quit
        <span className="mode-chart__key mode-chart__key--open" /> no end recorded
      </p>
      <ul className="sr-only">
        {rows.map((r) => (
          <li key={r.mode}>
            {modeLabel(r.mode)}: {r.starts} starts by {r.visitors} visitors, {r.finishes} finished, {r.quits} quit
            {r.medianTimeMs !== null ? `, median finish ${formatRaceTime(r.medianTimeMs)}` : ''}.
          </li>
        ))}
      </ul>
    </>
  );
}
