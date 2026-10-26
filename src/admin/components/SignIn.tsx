/**
 * The two screens before the dashboard: signed out (Google's button) and signed in but not an admin (a sign
 * out, so a different account can be tried). One layout for both, the game's: the italic logo, a caps kicker,
 * the heavy title, a line of copy and the card under the accent hairline. The forbidden screen promises the
 * player's save is untouched, since it is what any signed-in player who wanders here sees.
 */
import { useEffect, useRef, useState } from 'react';
import { LogOut, ShieldAlert } from 'lucide';
import { CLIENT_ID, renderGoogleButton, signIn, signOut } from '../lib/googleSignIn';
import { Button } from './Controls';
import { Icon } from './Icon';

function Shell({ kicker, title, lede, children }: { kicker: string; title: string; lede: string; children: React.ReactNode }) {
  return (
    <main className="sign-in">
      <div className="sign-in__column">
        <span className="logo sign-in__logo">Street Scene</span>
        <span className="label label--kicker">{kicker}</span>
        <h1 className="title sign-in__title">{title}</h1>
        <p className="sign-in__lede">{lede}</p>
        <div className="sign-in__card">{children}</div>
      </div>
    </main>
  );
}

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!CLIENT_ID || !slot.current) return;
    renderGoogleButton(
      slot.current,
      (credential) => {
        setBusy(true);
        setError(null);
        void signIn(credential).then((e) => {
          setBusy(false);
          if (e) setError(e);
          else onSignedIn();
        });
      },
      setError,
    );
  }, [onSignedIn]);
  return (
    <Shell kicker="Dashboard" title="Sign in" lede="Sign in with the Google account you play with. Only accounts on the admin list get past this screen.">
      {CLIENT_ID ? <div ref={slot} className={busy ? 'sign-in__google is-busy' : 'sign-in__google'} /> : <p className="sign-in__note">This build has no Google client id (VITE_GOOGLE_CLIENT_ID), so sign-in is off.</p>}
      {error ? (
        <p className="sign-in__error" role="alert">
          {error}
        </p>
      ) : null}
    </Shell>
  );
}

export function Forbidden({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <Shell kicker="Dashboard" title="Not an admin" lede="This account is not an admin. Sign out to try another one.">
      <p className="sign-in__note">
        <Icon node={ShieldAlert} size={16} />
        Your game save and garage are not affected.
      </p>
      <Button icon={LogOut} cls="--primary" onClick={() => void signOut().then(onSignedOut)}>
        Sign out
      </Button>
    </Shell>
  );
}
