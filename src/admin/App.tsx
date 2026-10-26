/**
 * The route guard for /dashboard. The session probe (`op=session`, cookie only, no database work) decides the
 * screen: 200 the dashboard, 401 the sign-in, 403 "not an admin". Nothing but the boot frame renders until the
 * probe answers, so neither screen can flash before the other replaces it. A lapsed session anywhere later
 * (any 401) comes back here and probes again.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AdminSessionPayload } from '../../api/_lib/adminTypes';
import { adminUrl } from './lib/api';
import { Dashboard, DashboardBoot } from './components/Dashboard';
import { Forbidden, SignIn } from './components/SignIn';
import { Toaster } from './components/Toaster';

type Gate = { state: 'probing' } | { state: 'signed-out' } | { state: 'forbidden' } | { state: 'admin'; admin: AdminSessionPayload };

async function probe(): Promise<Gate> {
  try {
    const res = await fetch(adminUrl('session'), { credentials: 'same-origin' });
    if (res.ok) return { state: 'admin', admin: (await res.json()) as AdminSessionPayload };
    return { state: res.status === 403 ? 'forbidden' : 'signed-out' };
  } catch {
    return { state: 'signed-out' };
  }
}

export function App() {
  const [gate, setGate] = useState<Gate>({ state: 'probing' });
  const recheck = useCallback(() => {
    setGate({ state: 'probing' });
    void probe().then(setGate);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void probe().then((g) => !cancelled && setGate(g));
    return () => void (cancelled = true);
  }, []);
  return (
    <>
      <Toaster />
      {gate.state === 'probing' ? <DashboardBoot /> : gate.state === 'admin' ? <Dashboard admin={gate.admin} onSignedOut={recheck} /> : gate.state === 'forbidden' ? <Forbidden onSignedOut={recheck} /> : <SignIn onSignedIn={recheck} />}
    </>
  );
}
