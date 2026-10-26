/**
 * The insight grid: the game's questions over one server-side aggregate (`op=insights`). Fed by the dashboard's
 * poll; it owns no fetch and no interval of its own (Neon bills compute hours, and a second loop for a second
 * panel is the cost mistake the CRM already corrected once). Its window (7, 30 or 90 days) is its own control,
 * because these numbers are scoped differently from the table below: a SQL aggregate over all recorded
 * traffic, which the browser-side filters cannot reach, and the header says so.
 *
 * Six columns when wide so cards can take halves, thirds and two thirds: the funnel and the modes share the top
 * row, then frame rate by tier, by GPU and the viewport ring, the three rank lists, and the hourly strip
 * beside the session times, then the Errors card across the whole width. SPANS and SHAPES are read by the real grid and its skeleton alike, so the loaded
 * panel lands exactly where the placeholder was.
 */
import { Car, Globe, MapPinned } from 'lucide';
import type { InsightsPayload } from '../../../api/_lib/adminTypes';
import { BarList } from '../charts/BarList';
import { FrameRateChart } from '../charts/FrameRate';
import { HourlyActivity } from '../charts/HourlyActivity';
import { ModeChart } from '../charts/ModeChart';
import { PlayFunnel } from '../charts/PlayFunnel';
import { SessionTimes } from '../charts/SessionTimes';
import { ViewportMix } from '../charts/ViewportMix';
import { formatHour, labelSource, localHourOffset } from '../lib/chartTheme';
import { TIER_LABEL, carName } from '../lib/gameVocab';
import { ChartFrame } from './ChartFrame';
import { ErrorList } from './ErrorList';
import { Segmented } from './Controls';
import { Icon } from './Icon';
import { InsightBodySkeleton, Line, type InsightShape } from './Skeleton';

export type InsightDays = 7 | 30 | 90;
export const INSIGHT_DAYS: readonly InsightDays[] = [7, 30, 90];
export const DEFAULT_INSIGHT_DAYS: InsightDays = 30;

/** Each card's span modifier and skeleton shape, in DOM order. */
/** Row counts are what a populated window shows: all six modes, the three tiers, six GPUs, eight sources (each card stretches to its row's tallest). */
const CARDS: readonly { span: 'half' | 'third' | 'two-thirds' | 'third-full' | 'full'; shape: InsightShape; rows?: number; axis?: boolean; legend?: boolean }[] = [
  { span: 'half', shape: 'rows', rows: 5 },
  { span: 'half', shape: 'rows', rows: 6, legend: true },
  { span: 'third', shape: 'rows', rows: 3, axis: true },
  { span: 'third', shape: 'rows', rows: 6, axis: true },
  { span: 'third', shape: 'ring' },
  { span: 'third', shape: 'bars', rows: 3 },
  { span: 'third', shape: 'bars', rows: 5 },
  { span: 'third', shape: 'bars', rows: 8 },
  { span: 'two-thirds', shape: 'hours' },
  // The last card: a third beside the hourly strip at six columns, the whole row at two (alone it would leave a hole).
  { span: 'third-full', shape: 'pair' },
  { span: 'full', shape: 'rows', rows: 3 },
];

const span = (i: number) => `insights__card insights__card--${CARDS[i].span}`;
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

function InsightsSkeleton() {
  return (
    <div className="insights__grid">
      {CARDS.map((card, i) => (
        <div key={i} className={`chart-card ${span(i)}`} aria-hidden="true">
          <div className="chart-card__caption">
            <Line w="6rem" line={15} bar={8} />
            <Line w="3rem" line={15} bar={8} />
          </div>
          <InsightBodySkeleton shape={card.shape} rows={card.rows} axis={card.axis} legend={card.legend} />
        </div>
      ))}
    </div>
  );
}

export function InsightsPanel({ data, days, onDaysChange }: { data: InsightsPayload | null; days: InsightDays; onDaysChange: (d: InsightDays) => void }) {
  const offset = localHourOffset();
  const peakHour = data?.hourly.reduce((best, row) => (row.sessions > best.sessions ? { hour: (((row.hour + (offset ?? 0)) % 24) + 24) % 24, sessions: row.sessions } : best), { hour: 0, sessions: 0 });
  const hasAnything = !!data && (data.sessions.total > 0 || data.funnel.visited > 0);

  return (
    <section className="dashboard__section" aria-labelledby="insights-heading">
      <div className="dashboard__section-head">
        <h2 id="insights-heading" className="section-title">
          Insights
        </h2>
        <div className="dashboard__section-tools">
          <Segmented label="Insights window" options={INSIGHT_DAYS.map((d) => ({ value: String(d), label: `${d}d`, title: `The last ${d} days` }))} value={String(days)} onChange={(v) => onDaysChange(Number(v) as InsightDays)} />
          <p className="dashboard__scope">Last {data?.windowDays ?? days} days · all recorded traffic, the filters below do not reach these</p>
        </div>
      </div>

      {data === null ? (
        <InsightsSkeleton />
      ) : !hasAnything ? (
        <div className="chart-card insights__empty">
          <p>No sessions recorded in the last {data.windowDays} days.</p>
          <p className="dashboard__scope">Visits, races and frame rates appear here as players arrive.</p>
        </div>
      ) : (
        <div className="insights__grid">
          <ChartFrame title="Play funnel" meta={plural(data.funnel.visited, 'visitor')} className={span(0)}>
            <PlayFunnel funnel={data.funnel} />
          </ChartFrame>

          <ChartFrame title="Race modes" meta="live drives, no replays" className={span(1)}>
            <ModeChart modes={data.modes} />
          </ChartFrame>

          <ChartFrame title="Frame rate by tier" meta={plural(data.tiers.reduce((s, t) => s + t.samples, 0), 'drive')} className={span(2)}>
            <FrameRateChart
              empty="No frame-rate summaries in this window."
              rows={data.tiers.map((t) => ({ key: t.tier, label: TIER_LABEL[t.tier], fps: t.medianFps, sub: `p95 ${Math.round(t.p95FrameMs)} ms · ${Math.round(t.slowShare * 100)}% of frames under 30 · ${plural(t.visitors, 'visitor')}` }))}
            />
          </ChartFrame>

          <ChartFrame title="Frame rate by GPU" meta="median fps" className={span(3)}>
            <FrameRateChart empty="No GPU reported a frame rate in this window." rows={data.gpus.slice(0, 6).map((g) => ({ key: g.gpu, label: g.gpu, fps: g.medianFps, sub: `mostly ${TIER_LABEL[g.tier]} · ${plural(g.visitors, 'visitor')}` }))} />
          </ChartFrame>

          <ChartFrame title="Viewport width" meta={plural(data.sessions.viewport.known, 'session')} className={span(4)}>
            <ViewportMix viewport={data.sessions.viewport} />
          </ChartFrame>

          <ChartFrame title="Top cars" meta="race starts" className={span(5)}>
            <BarList
              unit="starts"
              empty="No races started in this window."
              items={data.cars.map((c) => ({ label: carName(c.carId), lead: <Icon node={Car} size={12} />, value: c.starts, detail: plural(c.visitors, 'visitor') }))}
            />
          </ChartFrame>

          <ChartFrame title="Repeat seeds" meta="starts" className={span(6)}>
            <BarList
              unit="starts"
              empty="No city seed was raced more than once in this window."
              items={data.seeds.map((s) => ({ label: s.seedText ? `${s.seedText} (#${s.seed})` : `#${s.seed}`, lead: <Icon node={MapPinned} size={12} />, value: s.starts, detail: plural(s.visitors, 'visitor') }))}
            />
          </ChartFrame>

          <ChartFrame title="Sources" meta="sessions" className={span(7)}>
            <BarList
              unit="sessions"
              empty="No sessions in this window."
              items={data.sources.map((s) => ({ label: labelSource(s.host), lead: s.tagged ? <Icon node={Globe} size={12} label="campaign tag" /> : undefined, value: s.sessions, detail: s.tagged ? 'from a campaign tag' : 'from the referrer' }))}
            />
          </ChartFrame>

          <ChartFrame title="Sessions by hour" meta={peakHour && peakHour.sessions > 0 ? `peak ${formatHour(peakHour.hour)}${offset === null ? ' UTC' : ''}` : undefined} className={span(8)}>
            <HourlyActivity hourly={data.hourly} />
          </ChartFrame>

          <ChartFrame title="Time per session" meta={plural(data.sessions.total, 'session')} className={span(9)}>
            <SessionTimes sessions={data.sessions} />
          </ChartFrame>

          <ChartFrame title="Errors" meta={data.errorReports ? plural(data.errorReports, 'report') : 'crash reports'} className={span(10)}>
            <ErrorList rows={data.errors} />
          </ChartFrame>
        </div>
      )}
    </section>
  );
}
