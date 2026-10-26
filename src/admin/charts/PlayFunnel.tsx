/**
 * The play funnel: distinct visitors at each step from arriving to signing in. Each step is a subset of the one
 * before by construction in SQL (adminTypes PlayFunnel), so the bars can only narrow. Ordinal, so one hue in
 * rank steps across the whole validated ramp (bright at the top of the funnel, deep at the end); the steps are
 * close in value on a steep funnel, which is why rank and not magnitude picks the shade, and why every bar
 * also carries its count and share in words.
 */
import { ArrowDownRight } from 'lucide';
import type { PlayFunnel as Funnel } from '../../../api/_lib/adminTypes';
import { ChartEmpty } from '../components/ChartFrame';
import { Icon } from '../components/Icon';
import { rankStep } from '../lib/chartTheme';
import { share } from '../lib/dateFormat';

const STEPS: readonly { key: keyof Funnel; label: string; hint: string }[] = [
  { key: 'visited', label: 'Visited', hint: 'any recorded activity' },
  { key: 'started', label: 'Started a drive', hint: 'a race or free roam' },
  { key: 'finished', label: 'Finished a race', hint: 'crossed the line' },
  { key: 'savedBuild', label: 'Saved a build', hint: 'in the garage' },
  { key: 'signedIn', label: 'Signed in', hint: 'with Google' },
];

export function PlayFunnel({ funnel }: { funnel: Funnel }) {
  if (funnel.visited === 0) return <ChartEmpty>No visitors recorded in this window.</ChartEmpty>;
  return (
    <>
      <ol className="funnel" aria-hidden="true">
        {STEPS.map((step, i) => {
          const value = funnel[step.key];
          const prev = i > 0 ? funnel[STEPS[i - 1].key] : value;
          return (
            <li key={step.key} className="funnel__step" title={`${step.label} (${step.hint}): ${value} visitors`}>
              <span className="funnel__head">
                <span className="funnel__label">{step.label}</span>
                <span className="funnel__value">
                  {value} <span className="funnel__share">{share(value, funnel.visited)}%</span>
                </span>
              </span>
              <span className="funnel__track">
                <span className="funnel__fill" style={{ width: `${(value / funnel.visited) * 100}%`, background: rankStep(i, STEPS.length), minWidth: value > 0 ? 3 : 0 }} />
              </span>
              {i > 0 ? (
                <span className="funnel__rate">
                  <Icon node={ArrowDownRight} size={11} />
                  {share(value, prev)}% of the step above
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <ul className="sr-only">
        {STEPS.map((step, i) => (
          <li key={step.key}>
            {step.label}: {funnel[step.key]} visitors, {share(funnel[step.key], funnel.visited)}% of all visitors
            {i > 0 ? `, ${share(funnel[step.key], funnel[STEPS[i - 1].key])}% of the step above` : ''}.
          </li>
        ))}
      </ul>
    </>
  );
}
