/**
 * The drawer under an open row: the meta grid, then three tabs (the activity timeline, the race log, frame
 * rate), then the hand-edited fields (the location override and private notes) with Save and Delete. It reports
 * unsaved edits upward because the close paths it does not own (clicking the row again, another row, Escape,
 * paging) live in the list.
 */
import { useEffect, useState } from 'react';
import { Activity, Flag, Gauge, Save, Trash2, X } from 'lucide';
import { useVisitorDetail, type VisitorEdits } from '../hooks/useVisitorDetail';
import { ActivityTimeline, PerfLog, RaceLog } from './ActivityTimeline';
import { Button, Tabs } from './Controls';
import { DetailSkeleton } from './Skeleton';
import { VisitorMetaGrid } from './VisitorMetaGrid';

type Tab = 'activity' | 'races' | 'perf';

interface VisitorDetailProps {
  id: string;
  /** detailStamp() of the list row: decides whether the page-view cache can answer instead of the network. */
  stamp: string;
  onClose: () => void;
  onDeleted?: (id: string) => void;
  onSaved?: (id: string, edits: VisitorEdits) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onUnauthorized?: () => void;
}

export function VisitorDetail({ id, stamp, onClose, onDeleted, onSaved, onDirtyChange, onUnauthorized }: VisitorDetailProps) {
  const d = useVisitorDetail(id, stamp, { onClose, onDeleted, onSaved, onUnauthorized });
  const [tab, setTab] = useState<Tab>('activity');

  // Cleared on unmount too: once the drawer is gone there is nothing to discard, and a stale true would prompt on the next close.
  useEffect(() => {
    onDirtyChange?.(d.dirty);
    return () => onDirtyChange?.(false);
  }, [d.dirty, onDirtyChange]);

  const data = d.data;
  // Shown as the placeholder, so it is plain what the override replaces.
  const ipGuess = [data?.visitor.city, data?.visitor.region, data?.visitor.country].filter(Boolean).join(', ') || null;
  const races = data?.events.filter((e) => e.type === 'race_finish' || e.type === 'race_quit').length ?? 0;
  const perf = data?.events.filter((e) => e.type === 'perf').length ?? 0;

  return (
    <div className="visitor-detail">
      <div className="visitor-detail__head">
        <VisitorMetaGrid id={id} data={data} />
        <Button icon={X} cls="--small --ghost" onClick={onClose} label="Close" />
      </div>
      {data === null ? (
        <DetailSkeleton />
      ) : (
        <>
          <Tabs
            label="Visitor detail"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'activity', label: `Activity (${data.events.length + data.pageViews.length})`, icon: Activity },
              { value: 'races', label: `Races (${races})`, icon: Flag },
              { value: 'perf', label: `Frame rate (${perf})`, icon: Gauge },
            ]}
          />
          <div className="visitor-detail__pane">
            {tab === 'activity' ? <ActivityTimeline sessions={data.sessions} pageViews={data.pageViews} events={data.events} /> : null}
            {tab === 'races' ? <RaceLog events={data.events} /> : null}
            {tab === 'perf' ? <PerfLog events={data.events} /> : null}
          </div>
          <div className="visitor-detail__edit">
            <label className="label" htmlFor={`location-${id}`}>
              Location
            </label>
            <input id={`location-${id}`} type="text" className="visitor-detail__input" value={d.locationOverride} onChange={(e) => d.setLocationOverride(e.target.value)} placeholder={ipGuess ? `Correct the IP guess (${ipGuess})` : 'Set a location'} maxLength={120} />
            <p className="visitor-detail__hint">Overrides IP geolocation, which is approximate and can be off by hundreds of miles. Clear it to fall back to the IP guess.</p>
            <label className="label" htmlFor={`notes-${id}`}>
              Notes
            </label>
            <textarea id={`notes-${id}`} className="visitor-detail__input visitor-detail__notes" value={d.notes} onChange={(e) => d.setNotes(e.target.value)} placeholder="Private notes about this visitor" rows={3} />
            <div className="visitor-detail__actions">
              {/* Destructive looks destructive before it is clicked; Save opposite it reads as commit against destroy. */}
              <Button icon={Trash2} cls="--small visitor-detail__delete" onClick={() => void d.deleteVisitor()} disabled={d.deleting}>
                {d.deleting ? 'Deleting…' : 'Delete'}
              </Button>
              <Button icon={Save} cls="--small --primary" onClick={() => void d.saveDetails()} disabled={d.saving}>
                {d.saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
