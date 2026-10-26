/**
 * One visitor's detail payload, its editable fields (notes, location override) and the save and delete actions,
 * held in the page-view cache (lib/detailCache.ts) so reopening a row is instant.
 *
 * `stamp` (detailStamp) is read ONCE, on mount, then frozen: the open drawer never refreshes itself (only the
 * list behind it polls), because refetching under the cursor would wipe whatever was typed into Notes. A newer
 * stamp takes effect the next time the row is opened, when it cannot cost anyone their work.
 */
import { useEffect, useState } from 'react';
import type { VisitorDetailPayload, VisitorPatch } from '../../../api/_lib/adminTypes';
import { adminUrl, apiCall } from '../lib/api';
import { dropDetail, readDetail, writeDetail } from '../lib/detailCache';
import { toast } from '../lib/toast';

/** The admin-editable fields, as the list row should now show them. */
export interface VisitorEdits {
  location_override: string | null;
  notes: string | null;
}

interface Options {
  onClose: () => void;
  onDeleted?: (id: string) => void;
  /** Lets the list re-render its Location cell and notes mark without waiting for the next poll. */
  onSaved?: (id: string, edits: VisitorEdits) => void;
  onUnauthorized?: () => void;
}

export function useVisitorDetail(id: string, stamp: string, { onClose, onDeleted, onSaved, onUnauthorized }: Options) {
  const [key] = useState(stamp);
  // Read during the first render, not in an effect, so a revisit paints real content on its first frame.
  const [cached] = useState(() => readDetail(id, key));
  const [data, setData] = useState<VisitorDetailPayload | null>(cached);
  const [notes, setNotes] = useState(cached?.visitor.notes ?? '');
  const [locationOverride, setLocationOverride] = useState(cached?.visitor.location_override ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    void apiCall<VisitorDetailPayload>(adminUrl('visitor', { id }), undefined, { errorMessage: 'Failed to load visitor.', onUnauthorized }).then((json) => {
      if (!json || cancelled) return;
      setData(json);
      setNotes(json.visitor.notes ?? '');
      setLocationOverride(json.visitor.location_override ?? '');
    });
    return () => void (cancelled = true);
  }, [id, cached, onUnauthorized]);

  // Mirror whatever is on screen into the cache from one place: the fetch landing and the merge after a save.
  useEffect(() => {
    if (data) writeDetail(id, key, data);
  }, [id, key, data]);

  /**
   * Unsaved edits, compared trimmed against what the server holds (a save stores `trim() || null`, so a field of
   * only whitespace is not a pending edit). The list guards every close path against this.
   */
  const dirty = data !== null && (notes.trim() !== (data.visitor.notes ?? '') || locationOverride.trim() !== (data.visitor.location_override ?? ''));

  async function saveDetails(): Promise<void> {
    if (!data) return;
    setSaving(true);
    const body: VisitorPatch = { notes: notes.trim() || null, location_override: locationOverride.trim() || null };
    const result = await apiCall(adminUrl('visitor', { id }), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { errorMessage: 'Failed to save changes.', onUnauthorized });
    setSaving(false);
    if (!result) return;
    const edits: VisitorEdits = { notes: body.notes ?? null, location_override: body.location_override ?? null };
    setData((prev) => (prev ? { ...prev, visitor: { ...prev.visitor, ...edits } } : prev));
    onSaved?.(id, edits);
    toast.success('Changes saved.');
  }

  async function deleteVisitor(): Promise<void> {
    if (!confirm('Permanently delete this visitor with every session, page view and event? Their player account is kept. This cannot be undone.')) return;
    setDeleting(true);
    const result = await apiCall(adminUrl('visitor', { id }), { method: 'DELETE' }, { errorMessage: 'Failed to delete visitor.', onUnauthorized });
    if (!result) return setDeleting(false);
    // Before the unmount, so nothing can re-mirror the payload on the way out.
    dropDetail(id);
    toast.success('Visitor deleted.');
    onDeleted?.(id);
    onClose();
  }

  return { data, notes, setNotes, locationOverride, setLocationOverride, dirty, saving, saveDetails, deleting, deleteVisitor };
}
