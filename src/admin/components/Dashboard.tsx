/**
 * The dashboard: the header, the totals, the insight grid and the visitor table, all fed by one poll.
 *
 * One fetch pass is two requests (the visitor list and the insights aggregate, whose transaction also carries
 * the visitors-per-day series), every 120 s and ONLY while the tab is visible: Neon bills compute hours and
 * autosuspends an idle endpoint, and a background tab polling forever would pin it awake for data nobody is
 * looking at. Becoming visible refetches at once, so it still feels live.
 *
 * Two kinds of narrowing, at two levels on purpose. The timeframe and the two filters are statements about
 * which traffic counts, so they define the working set the totals read too (tiles reading 28 while the table
 * shows 25, with rates diluted by crawlers, would defeat the point). Search is a lookup: it narrows only the
 * table and never rewrites the totals above it. The proxy bursts are computed over the FULL list, before the
 * timeframe narrows it, so a cluster straddling midnight does not half-dissolve.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CarFront, CircleUser, Flag, LogOut, RefreshCw, Users } from 'lucide';
import type { AdminSessionPayload, InsightsPayload, VisitorListPayload, VisitorSummary } from '../../../api/_lib/adminTypes';
import { VisitorsChart } from '../charts/VisitorsChart';
import { isBoolean, usePersisted } from '../hooks/usePersisted';
import { adminUrl, apiCall } from '../lib/api';
import { signOut } from '../lib/googleSignIn';
import { detectProxyBursts, hasDriven, isAutomated } from '../lib/classify';
import { formatDuration, share } from '../lib/dateFormat';
import { isNewSince, useLastVisit } from '../lib/lastVisit';
import { DEFAULT_TIMEFRAME, isTimeframe, withinTimeframe } from '../lib/timeframe';
import { Button } from './Controls';
import { DEFAULT_INSIGHT_DAYS, INSIGHT_DAYS, InsightsPanel, type InsightDays } from './InsightsPanel';
import { Skeleton, StatTileSkeleton } from './Skeleton';
import { StatTile } from './StatTile';
import { VisitorsPanel } from './VisitorsPanel';

/** Two minutes: the visitor list is not a live feed, and this halves an open tab's query volume against one. */
const POLL_MS = 120_000;
/** No input for this long and polling pauses, in ms. */
const IDLE_MS = 5 * 60_000;

const isInsightDays = (v: unknown): v is InsightDays => INSIGHT_DAYS.includes(v as InsightDays);

/** The header's brand, the same in the boot frame and the loaded page (a skeleton over known text would stand in for itself). */
export function DashboardBrand() {
  return (
    <div className="dashboard__brand">
      <span className="logo dashboard__logo">Street Scene</span>
      <h1 className="title dashboard__title">Dashboard</h1>
    </div>
  );
}

export function Dashboard({ admin, onSignedOut }: { admin: AdminSessionPayload; onSignedOut: () => void }) {
  const [visitors, setVisitors] = useState<VisitorSummary[] | null>(null);
  const [insights, setInsights] = useState<InsightsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  // Off by default so nothing is hidden until asked; persisted, since a filter wanted today is wanted tomorrow.
  const [hideAutomated, setHideAutomated] = usePersisted('hideAutomated', false, isBoolean);
  const [driversOnly, setDriversOnly] = usePersisted('driversOnly', false, isBoolean);
  const [timeframe, setTimeframe] = usePersisted('timeframe', DEFAULT_TIMEFRAME, isTimeframe);
  const [days, setDays] = usePersisted<InsightDays>('insightDays', DEFAULT_INSIGHT_DAYS, isInsightDays);
  // Frozen for the session and stamped on the way out (lib/lastVisit.ts); distinct from this tab's poll time.
  const newSince = useLastVisit();

  const fetchData = useCallback(
    () =>
      Promise.all([
        apiCall<VisitorListPayload>(adminUrl('visitors'), undefined, { errorMessage: 'Failed to load visitors.', onUnauthorized: onSignedOut }),
        apiCall<InsightsPayload>(adminUrl('insights', { days }), undefined, { errorMessage: 'Failed to load insights.', onUnauthorized: onSignedOut }),
      ]).then(([v, i]) => {
        if (v) setVisitors(v.visitors);
        if (i) setInsights(i);
        setLoading(false);
        setLastLoaded(new Date());
      }),
    [onSignedOut, days],
  );

  const load = useCallback(() => {
    setLoading(true);
    return fetchData();
  }, [fetchData]);

  useEffect(() => void fetchData(), [fetchData]);

  // Polls only while the tab is visible AND someone is at it: a dashboard left open on a screen would otherwise
  // keep the free Neon compute awake around the clock (it shares a monthly allowance with the game's accounts).
  // A poll due while idle is skipped; the first input after it reloads at once.
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    let lastInput = Date.now();
    let missed = false;
    const tick = () => {
      if (Date.now() - lastInput < IDLE_MS) void load();
      else missed = true;
    };
    const start = () => (id ??= setInterval(tick, POLL_MS));
    const stop = () => {
      clearInterval(id);
      id = undefined;
    };
    const onInput = () => {
      lastInput = Date.now();
      if (missed) {
        missed = false;
        void load();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return stop();
      lastInput = Date.now();
      missed = false;
      void load();
      start();
    };
    const inputs = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;
    for (const t of inputs) window.addEventListener(t, onInput, { capture: true, passive: true });
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      for (const t of inputs) window.removeEventListener(t, onInput, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  const changeDays = useCallback(
    (d: InsightDays) => {
      setDays(d);
      setInsights(null);
    },
    [setDays],
  );

  // Ends the shared session (the game's account cookie). Failure is swallowed: the local sign-out must happen anyway.
  async function handleSignOut(): Promise<void> {
    await signOut();
    onSignedOut();
  }

  const handleDeleted = useCallback((id: string) => setVisitors((prev) => prev?.filter((v) => v.id !== id) ?? null), []);

  const bursts = useMemo(() => detectProxyBursts(visitors ?? []), [visitors]);
  const inWindow = useMemo(() => (visitors ? withinTimeframe(visitors, timeframe) : null), [visitors, timeframe]);
  const automatedCount = useMemo(() => inWindow?.filter((v) => isAutomated(v, bursts)).length ?? 0, [inWindow, bursts]);
  // Counted after the automated filter, so a label never promises to hide rows already gone.
  const afterAutomated = useMemo(() => (hideAutomated && inWindow ? inWindow.filter((v) => !isAutomated(v, bursts)) : inWindow), [hideAutomated, inWindow, bursts]);
  const quietCount = afterAutomated?.filter((v) => !hasDriven(v)).length ?? 0;
  const base = useMemo(() => (driversOnly && afterAutomated ? afterAutomated.filter(hasDriven) : afterAutomated), [driversOnly, afterAutomated]);
  // Over the rows actually on screen, so the readout can never promise dots the filters took away.
  const newCount = base?.filter((v) => isNewSince(v, newSince)).length ?? 0;

  const totals = useMemo(() => {
    const rows = base ?? [];
    return {
      visitors: rows.length,
      drivers: rows.filter(hasDriven).length,
      starts: rows.reduce((s, v) => s + v.race_start_count, 0),
      finishes: rows.reduce((s, v) => s + v.race_finish_count, 0),
      drivingMs: rows.reduce((s, v) => s + v.total_race_ms, 0),
      players: rows.filter((v) => v.player_email).length,
    };
  }, [base]);

  return (
    <main className="dashboard">
      <header className="dashboard__header">
        <DashboardBrand />
        <div className="dashboard__actions">
          <span className="dashboard__who" title={`Signed in as ${admin.name} (${admin.email})`}>
            {admin.email}
          </span>
          {lastLoaded ? <span className={loading ? 'dashboard__pulse is-loading' : 'dashboard__pulse'}>{lastLoaded.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
          <Button icon={RefreshCw} cls="--small --primary" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
          <Button icon={LogOut} cls="--small" onClick={() => void handleSignOut()}>
            Sign out
          </Button>
        </div>
      </header>

      <section className="dashboard__section" aria-labelledby="totals-heading">
        <div className="dashboard__section-head">
          <h2 id="totals-heading" className="section-title">
            Totals
          </h2>
          <p className="dashboard__scope">The visitors in view · the timeframe and filters below narrow these, search does not</p>
        </div>
        <div className="dashboard__totals">
          {visitors === null ? (
            <TotalsSkeleton />
          ) : (
            <>
              <StatTile label="Visitors" value={totals.visitors} sub={timeframe === 'all' ? 'all time' : 'in this timeframe'} icon={Users} />
              <StatTile label="Drivers" value={totals.drivers} sub={`started a drive · ${share(totals.drivers, totals.visitors)}%`} icon={CarFront} meter={[totals.drivers, totals.visitors]} />
              <StatTile label="Races" value={totals.starts} sub={`${totals.finishes} finished · ${formatDuration(totals.drivingMs)} driving`} icon={Flag} meter={[totals.finishes, totals.starts]} />
              <StatTile label="Players" value={totals.players} sub={`signed in · ${share(totals.players, totals.visitors)}%`} icon={CircleUser} meter={[totals.players, totals.visitors]} />
              <div className="dashboard__chart-tile">{insights ? <VisitorsChart days={insights.days} /> : <Skeleton h={98} />}</div>
            </>
          )}
        </div>
      </section>

      <InsightsPanel data={insights} days={days} onDaysChange={changeDays} />

      <VisitorsPanel
        visitors={base}
        totalCount={inWindow?.length ?? 0}
        bursts={bursts}
        newSince={newSince}
        newCount={newCount}
        loading={loading}
        hasAnyVisitors={visitors !== null && visitors.length > 0}
        timeframe={timeframe}
        onTimeframeChange={setTimeframe}
        hideAutomated={hideAutomated}
        automatedCount={automatedCount}
        onToggleAutomated={() => setHideAutomated((h) => !h)}
        driversOnly={driversOnly}
        quietCount={quietCount}
        onToggleDrivers={() => setDriversOnly((d) => !d)}
        onVisitorDeleted={handleDeleted}
        onUnauthorized={onSignedOut}
      />
    </main>
  );
}

/** The totals row at rest: four tiles and the chart tile, on the same grid. */
export function TotalsSkeleton() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <StatTileSkeleton key={i} />
      ))}
      <div className="dashboard__chart-tile" aria-hidden="true">
        <Skeleton h={98} />
      </div>
    </>
  );
}

/**
 * What fills the screen while the session probe is in flight: the dashboard frame at rest, every panel in its
 * own loading state, driven through the real panels with null data so the placeholder cannot drift from them.
 * It asserts nothing about the session: the probe may still come back signed out.
 */
export function DashboardBoot() {
  const noop = () => undefined;
  return (
    <main className="dashboard">
      <header className="dashboard__header">
        <DashboardBrand />
        <div className="dashboard__actions" aria-hidden="true">
          <Skeleton w="6.5rem" h={32} />
          <Skeleton w="6.5rem" h={32} />
        </div>
      </header>
      <section className="dashboard__section">
        <div className="dashboard__section-head">
          <h2 className="section-title">Totals</h2>
        </div>
        <div className="dashboard__totals">
          <TotalsSkeleton />
        </div>
      </section>
      <InsightsPanel data={null} days={DEFAULT_INSIGHT_DAYS} onDaysChange={noop} />
      <VisitorsPanel
        visitors={null}
        totalCount={0}
        newSince={null}
        newCount={0}
        loading={false}
        hasAnyVisitors={false}
        timeframe={DEFAULT_TIMEFRAME}
        onTimeframeChange={noop}
        hideAutomated={false}
        automatedCount={0}
        onToggleAutomated={noop}
        driversOnly={false}
        quietCount={0}
        onToggleDrivers={noop}
        onVisitorDeleted={noop}
        onUnauthorized={noop}
      />
    </main>
  );
}
