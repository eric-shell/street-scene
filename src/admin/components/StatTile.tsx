/**
 * A totals tile: a caps label with its icon, the number, an optional meter, a sub line. `meter` is for tiles
 * whose number IS the numerator of the ratio in the sub line (drawn from the same values in the same render,
 * so bar and percentage cannot disagree); a tile with no denominator on the page gets none, rather than a
 * maximum invented to draw against. The meter is the accent like every data mark, never a semantic color.
 */
import type { IconNode } from 'lucide';
import { ACCENT } from '../lib/chartTheme';
import { share } from '../lib/dateFormat';
import { Icon } from './Icon';

export function StatTile({ label, value, sub, icon, meter }: { label: string; value: number | string; sub: string; icon: IconNode; meter?: [number, number] }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile__label">
        <Icon node={icon} size={13} />
        {label}
      </span>
      <span className="stat-tile__value">{value}</span>
      <span className="stat-tile__meter" aria-hidden="true">
        {meter && meter[0] > 0 ? <span className="stat-tile__meter-fill" style={{ width: `${share(meter[0], meter[1])}%`, background: ACCENT }} /> : null}
      </span>
      <span className="stat-tile__sub">{sub}</span>
    </div>
  );
}
