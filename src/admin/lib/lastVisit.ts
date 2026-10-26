/**
 * "New since you last looked": the watermark and the predicate that reads it. The dashboard polls, so rows
 * appear under you; this is the memory of where the last visit ended. Not an unread count: nothing is marked
 * read row by row, and opening a row does not clear its dot. The watermark moves once, on the way out.
 */
import { useEffect, useState } from 'react';
import type { VisitorSummary } from '../../../api/_lib/adminTypes';
import { loadText, saveText } from '../../shared/store';

const LAST_VISIT_KEY = 'dashboard.lastVisit';

/** Whether this row picked up activity after the watermark (parsed, not compared as text: the driver's timestamp format is not guaranteed to sort). */
export function isNewSince(v: VisitorSummary, since: number | null): boolean {
  if (since === null) return false;
  return new Date(v.last_activity_at).getTime() > since;
}

/**
 * Epoch ms of the previous visit, or null for none. Read once and frozen for the session: a watermark that
 * advanced while you read would un-mark rows under the cursor. It is stamped on unmount (sign-out), on
 * `pagehide` and when the tab is hidden, all three because mobile Safari often never fires `pagehide`. A
 * first-ever visit marks nothing: dotting all 500 rows would say nothing.
 */
export function useLastVisit(): number | null {
  const [since] = useState<number | null>(() => {
    const raw = loadText(LAST_VISIT_KEY);
    const ms = raw ? Date.parse(raw) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  });
  useEffect(() => {
    const stamp = () => void saveText(LAST_VISIT_KEY, new Date().toISOString());
    const onHide = () => document.visibilityState === 'hidden' && stamp();
    window.addEventListener('pagehide', stamp);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', stamp);
      document.removeEventListener('visibilitychange', onHide);
      stamp();
    };
  }, []);
  return since;
}
