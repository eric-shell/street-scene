/**
 * What one visitor did, read from the stored events and page views. Each event type renders from its own
 * metadata (shared/analytics.ts EventMetaMap): a finish shows its time and place, a quit how far in, a perf
 * summary its frame rate against the game's lines, a build save its car and slot.
 *
 * ActivityTimeline groups by session (newest session first, each read oldest to newest: a visit reads best in
 * order), with the session's engaged and driving time, its build hash and how it arrived in the header. Rows
 * whose session is not in the list (a failed session write) are kept in an "Unattributed" block rather than
 * vanishing. RaceLog and PerfLog are the same events as flat newest-first lists, for scanning results and
 * frame rates across visits.
 */
import type { ReactNode } from 'react';
import { CircleUser, Download, Eye, Flag, Gauge, LogOut, Save, Share2, Tag, TriangleAlert, Trophy, Warehouse, X, type IconNode } from 'lucide';
import type { PageView, VisitorEvent, VisitorSession } from '../../../api/_lib/adminTypes';
import { FpsBadge } from '../charts/FrameRate';
import { formatClock, formatDuration, formatLong, formatRaceTime, ordinal } from '../lib/dateFormat';
import { ERROR_KIND, MODES, TIER_LABEL, carName, isMode, modeLabel } from '../lib/gameVocab';
import { Icon } from './Icon';

/** A race type as the game's chip: its icon and name in its color (base/_tokens.scss .mode-*, kit chip--mode). */
function ModeChip({ mode }: { mode: string }) {
  return (
    <span className={isMode(mode) ? `chip chip--small chip--mode mode-${mode}` : 'chip chip--small'}>
      {isMode(mode) ? <Icon node={MODES[mode].icon} size={12} /> : null}
      <span className="chip__label">{modeLabel(mode)}</span>
    </span>
  );
}

const QUIT_REASON = { quit: 'quit from pause', restart: 'restarted', pagehide: 'closed the page' } as const;

/** One event as a timeline line: its icon, what happened and the details that matter for its type. */
function describe(e: VisitorEvent): { icon: IconNode; tone?: 'good' | 'bad'; body: ReactNode } {
  switch (e.type) {
    case 'race_start': {
      const m = e.metadata;
      return {
        icon: isMode(m.mode) ? MODES[m.mode].icon : Flag,
        body: (
          <>
            {m.replay ? 'Watched a replay of' : 'Started'} <ModeChip mode={m.mode} /> in the {carName(m.carId)}
            <span className="timeline-entry__dim">
              {' · '}seed {m.seedText ? `“${m.seedText}”` : `#${m.seed}`}
              {m.opponents > 0 ? ` · ${m.opponents} ${m.opponents === 1 ? 'rival' : 'rivals'}, ${m.difficulty}` : ''}
              {m.ghost ? ' · ghost on' : ''}
            </span>
          </>
        ),
      };
    }
    case 'race_finish': {
      const m = e.metadata;
      return {
        icon: m.personalBest ? Trophy : Flag,
        tone: 'good',
        body: (
          <>
            Finished <ModeChip mode={m.mode} /> in <strong>{formatRaceTime(m.timeMs)}</strong>
            {m.entrants > 1 ? (
              <>
                , <strong>{ordinal(m.place)}</strong> of {m.entrants}
              </>
            ) : null}
            {m.score !== undefined ? <> · {m.score.toLocaleString()} pts</> : null}
            {m.personalBest ? <span className="timeline-entry__best"> · personal best</span> : null}
            <span className="timeline-entry__dim"> · {carName(m.carId)}</span>
          </>
        ),
      };
    }
    case 'race_quit': {
      const m = e.metadata;
      return {
        icon: X,
        tone: 'bad',
        body: (
          <>
            Left <ModeChip mode={m.mode} /> after {formatDuration(m.elapsedMs)}
            {m.progress !== undefined ? <> at {Math.round(m.progress * 100)}%</> : null}
            <span className="timeline-entry__dim"> · {QUIT_REASON[m.reason]}</span>
          </>
        ),
      };
    }
    case 'garage_open':
      return { icon: Warehouse, body: <>Opened the garage{e.metadata.viaDoor ? ' through the roller door' : ' directly'}</> };
    case 'build_save':
      return { icon: Save, tone: 'good', body: <>Saved a {carName(e.metadata.carId)} build to slot {e.metadata.slot + 1}</> };
    case 'build_share':
      return { icon: Share2, body: <>Shared a {carName(e.metadata.carId)} build</> };
    case 'build_import':
      return { icon: Download, body: <>Imported a shared {carName(e.metadata.carId)} build</> };
    case 'sign_in':
      return { icon: CircleUser, tone: 'good', body: <>Signed in{e.metadata.newAccount ? ', a new account' : ''}</> };
    case 'sign_out':
      return { icon: LogOut, body: <>Signed out</> };
    case 'race_share':
      return { icon: Share2, tone: 'good', body: <>Sent a <ModeChip mode={e.metadata.mode} /> challenge<span className="timeline-entry__dim"> · {e.metadata.via === 'share' ? 'share sheet' : 'copied link'}</span></> };
    case 'error': {
      const m = e.metadata;
      return {
        icon: TriangleAlert,
        tone: 'bad',
        body: (
          <>
            <strong>{ERROR_KIND[m.kind]}</strong> {m.message}
            {m.screen ? <span className="timeline-entry__dim"> · on the {m.screen}</span> : null}
            {m.stack ? <pre className="timeline-entry__stack">{m.stack}</pre> : null}
          </>
        ),
      };
    }
    case 'perf': {
      const m = e.metadata;
      return {
        icon: Gauge,
        body: (
          <>
            <strong>{Math.round(m.medianFps)} fps</strong> <FpsBadge fps={m.medianFps} /> on <ModeChip mode={m.mode} />
            <span className="timeline-entry__dim">
              {' · '}p95 {Math.round(m.p95FrameMs)} ms · {Math.round(m.slowShare * 100)}% under 30 · {TIER_LABEL[m.tier]}
              {m.auto ? ' (auto)' : ' (pinned)'}
            </span>
          </>
        ),
      };
    }
  }
}

type Entry = { at: string; key: string; node: ReactNode };

function eventEntry(e: VisitorEvent, long = false): Entry {
  const d = describe(e);
  return {
    at: e.created_at,
    key: `e${e.id}`,
    node: (
      <li key={`e${e.id}`} className={d.tone ? `timeline-entry timeline-entry--${d.tone}` : 'timeline-entry'}>
        <span className="timeline-entry__icon">
          <Icon node={d.icon} size={13} />
        </span>
        <span className="timeline-entry__body">{d.body}</span>
        <time className="timeline-entry__time" dateTime={e.created_at}>
          {long ? formatLong(e.created_at) : formatClock(e.created_at)}
        </time>
      </li>
    ),
  };
}

function viewEntry(pv: PageView, long = false): Entry {
  return {
    at: pv.created_at,
    key: `p${pv.id}`,
    node: (
      <li key={`p${pv.id}`} className="timeline-entry timeline-entry--view">
        <span className="timeline-entry__icon">
          <Icon node={Eye} size={13} />
        </span>
        <span className="timeline-entry__body">
          Opened <span className="timeline-entry__path">{pv.path}</span>
        </span>
        <time className="timeline-entry__time" dateTime={pv.created_at}>
          {long ? formatLong(pv.created_at) : formatClock(pv.created_at)}
        </time>
      </li>
    ),
  };
}

function SessionHead({ s }: { s: VisitorSession }) {
  const utm = ([['source', s.utm_source], ['medium', s.utm_medium], ['campaign', s.utm_campaign]] as const).filter(([, v]) => v);
  return (
    <div className="timeline-session__head">
      <span className="timeline-session__when">{formatLong(s.started_at)}</span>
      <span className="timeline-session__stats">
        <span title="Engaged time: the tab visible">{formatDuration(s.engaged_ms)} engaged</span>
        <span title="A race or free roam running">{formatDuration(s.race_ms)} driving</span>
        <span>
          {s.page_view_count} {s.page_view_count === 1 ? 'view' : 'views'}
        </span>
        {s.viewport_w && s.viewport_h ? (
          <span title="Viewport, and the screen in parentheses">
            {s.viewport_w}×{s.viewport_h}
            {s.screen_w && s.screen_h ? ` (${s.screen_w}×${s.screen_h})` : ''}
          </span>
        ) : null}
        {s.build ? (
          <span className="timeline-session__build" title="The game build this visit ran">
            {s.build}
          </span>
        ) : null}
      </span>
      {s.referrer ? <span className="timeline-session__from">Referred by {s.referrer}</span> : null}
      {utm.length > 0 ? (
        <span className="timeline-session__from">
          <Icon node={Tag} size={11} />
          <span className="sr-only">Campaign tags:</span>
          {utm.map(([k, v]) => (
            <span key={k} className="timeline-session__utm">
              <span className="timeline-entry__dim">{k}</span> {v}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

export function ActivityTimeline({ sessions, pageViews, events }: { sessions: VisitorSession[]; pageViews: PageView[]; events: VisitorEvent[] }) {
  if (sessions.length === 0 && pageViews.length === 0 && events.length === 0) {
    return <p className="timeline__empty">Nothing recorded for this visitor: their beacons were blocked, or they arrived before the analytics shipped.</p>;
  }
  const known = new Set(sessions.map((s) => s.id));
  const bySession = new Map<string, Entry[]>();
  const orphans: Entry[] = [];
  // Within a session the day is in its header, so entries show the clock; an orphan has no header and shows the full date.
  const place = (sid: string | null, entry: (long: boolean) => Entry) => {
    if (sid && known.has(sid)) bySession.set(sid, [...(bySession.get(sid) ?? []), entry(false)]);
    else orphans.push(entry(true));
  };
  for (const pv of pageViews) place(pv.session_id, (long) => viewEntry(pv, long));
  for (const e of events) place(e.session_id, (long) => eventEntry(e, long));
  const ordered = (list: Entry[]) => [...list].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  return (
    <div className="timeline">
      {sessions.map((s) => {
        const entries = ordered(bySession.get(s.id) ?? []);
        return (
          <div key={s.id} className="timeline-session">
            <SessionHead s={s} />
            {entries.length > 0 ? <ul className="timeline-session__entries">{entries.map((x) => x.node)}</ul> : <p className="timeline__empty">Heartbeats only: no page view or event recorded in this session.</p>}
          </div>
        );
      })}
      {orphans.length > 0 ? (
        <div className="timeline-session timeline-session--orphans">
          <div className="timeline-session__head">
            <span className="label">Unattributed</span>
          </div>
          <ul className="timeline-session__entries">{ordered(orphans).map((x) => x.node)}</ul>
        </div>
      ) : null}
    </div>
  );
}

/** Every finish and quit, newest first. */
export function RaceLog({ events }: { events: VisitorEvent[] }) {
  const rows = events.filter((e) => e.type === 'race_finish' || e.type === 'race_quit');
  if (rows.length === 0) return <p className="timeline__empty">No race finished or left yet.</p>;
  return <ul className="timeline-session__entries timeline--flat">{[...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((e) => eventEntry(e, true).node)}</ul>;
}

/** Every frame-rate summary, newest first. */
export function PerfLog({ events }: { events: VisitorEvent[] }) {
  const rows = events.filter((e) => e.type === 'perf');
  if (rows.length === 0) return <p className="timeline__empty">No frame-rate summary yet: one is sent as each drive ends.</p>;
  return <ul className="timeline-session__entries timeline--flat">{[...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((e) => eventEntry(e, true).node)}</ul>;
}
