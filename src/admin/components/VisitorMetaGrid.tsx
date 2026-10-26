/**
 * The facts about one visitor at the top of the drawer, each an icon in a chamfered well over a caps label and
 * a value. The linked player leads after the id, since it is the one thing here a person chose to tell us.
 * Location says "approx." when it is IP-derived; the browser-reported time zone is preferred over the IP's and
 * the fallback is labelled. Engagement folds views, sessions and time into one field so the block stays short
 * enough to keep the tabs above the fold.
 */
import { CalendarDays, CarFront, CircleUser, Clock, Compass, Cpu, Fingerprint, Gauge, Globe, Languages, Link, Monitor, MousePointerClick, type IconNode } from 'lucide';
import type { VisitorDetailPayload } from '../../../api/_lib/adminTypes';
import { FpsBadge } from '../charts/FrameRate';
import { formatDuration, formatLong, formatMonthDay } from '../lib/dateFormat';
import { TIER_LABEL } from '../lib/gameVocab';
import { resolveLocation } from '../lib/location';
import { formatUserAgent } from '../lib/userAgent';
import { Icon } from './Icon';
import { MetaFieldSkeletons } from './Skeleton';

function MetaField({ icon, label, value, mono, title, wide }: { icon: IconNode; label: string; value: React.ReactNode; mono?: boolean; title?: string; wide?: boolean }) {
  return (
    <div className={wide ? 'meta-field meta-field--wide' : 'meta-field'} title={title}>
      <span className="meta-field__icon">
        <Icon node={icon} size={14} />
      </span>
      <span className="meta-field__text">
        <span className="meta-field__label">{label}</span>
        <span className={mono ? 'meta-field__value meta-field__value--mono' : 'meta-field__value'}>{value}</span>
      </span>
    </div>
  );
}

/** Median of a list of numbers. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function VisitorMetaGrid({ id, data }: { id: string; data: VisitorDetailPayload | null }) {
  const v = data?.visitor;
  const sessions = data?.sessions ?? [];
  const engaged = sessions.reduce((s, x) => s + x.engaged_ms, 0);
  const driving = sessions.reduce((s, x) => s + x.race_ms, 0);
  const location = resolveLocation(v);
  // Acquisition lives on the first session when the visitor row has none: sessions are newest first, so the last one holding a referrer is the earliest.
  const referrer = v?.referrer ?? [...sessions].reverse().find((s) => s.referrer)?.referrer ?? null;
  const perf = data?.events.flatMap((e) => (e.type === 'perf' ? [e.metadata] : [])) ?? [];
  const fps = median(perf.map((p) => p.medianFps));
  const device = v ? [v.cores ? `${v.cores} cores` : null, v.memory_gb ? `${v.memory_gb} GB` : null, v.dpr ? `${v.dpr}x` : null, v.touch ? 'touch' : null].filter(Boolean).join(' · ') : '';
  return (
    <div className="meta-grid">
      <MetaField icon={Fingerprint} label="Visitor ID" value={id} mono />
      {data === null || !v ? (
        <MetaFieldSkeletons count={8} />
      ) : (
        <>
          {data.player ? (
            <MetaField
              icon={CircleUser}
              label="Player"
              value={
                <>
                  {data.player.name} <span className="meta-field__dim">{data.player.email}</span>
                </>
              }
              title={`Account since ${formatMonthDay(data.player.created_at)}, last seen ${formatLong(data.player.seen_at)}`}
            />
          ) : null}
          <MetaField icon={CalendarDays} label="First seen" value={formatLong(v.first_seen_at)} />
          <MetaField icon={Clock} label="Last seen" value={formatLong(v.last_seen_at)} />
          {v.user_agent ? <MetaField icon={Monitor} label="Browser" value={formatUserAgent(v.user_agent)} title={v.user_agent} /> : null}
          {v.gpu ? <MetaField icon={Cpu} label="GPU" value={v.gpu} title={v.gpu} /> : null}
          {device ? <MetaField icon={Monitor} label="Device" value={device} title="Cores, memory (Chromium only), pixel ratio and touch, from the renderer's probe" /> : null}
          {location.label ? (
            <MetaField icon={Globe} label={location.approximate ? 'Location (approx.)' : 'Location'} value={location.label} title={location.approximate ? 'From IP geolocation: can be off by hundreds of miles. Correct it below.' : 'Corrected by hand.'} />
          ) : null}
          {v.client_timezone || v.timezone ? (
            <MetaField icon={Compass} label={v.client_timezone ? 'Time zone' : 'Time zone (from IP)'} value={v.client_timezone ?? v.timezone} title={v.client_timezone ? 'Reported by the browser.' : 'Inferred from the IP: less reliable.'} />
          ) : null}
          {v.language ? <MetaField icon={Languages} label="Language" value={v.language} /> : null}
          {sessions.length > 0 ? (
            <MetaField
              icon={MousePointerClick}
              label="Engagement"
              value={[`${data.pageViews.length} ${data.pageViews.length === 1 ? 'view' : 'views'}`, `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`, formatDuration(engaged)].join(' · ')}
              title="Engaged time counts only while the tab was visible, summed across sessions."
            />
          ) : null}
          {driving > 0 ? <MetaField icon={CarFront} label="Driving" value={formatDuration(driving)} title="A race or free roam running, summed across sessions." /> : null}
          {fps !== null ? (
            <MetaField
              icon={Gauge}
              label="Frame rate"
              value={
                <>
                  {Math.round(fps)} fps <FpsBadge fps={fps} /> {perf[0] ? <span className="meta-field__dim">{TIER_LABEL[perf[0].tier]}</span> : null}
                </>
              }
              title="Median of this visitor's driving frame-rate summaries; the tier is the latest one."
            />
          ) : null}
          {referrer ? <MetaField icon={Link} label="Referrer" value={referrer} title={referrer} /> : null}
        </>
      )}
    </div>
  );
}
