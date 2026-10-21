import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Circle, type Me } from './api';
import { completeSignIn, isSignedIn, signIn, signOut, signOutEverywhere } from './auth';
import { AccountPage, AlertsPage, CreateCirclePage, MedicationsPage, MembersPage, SettingsPage, TimelinePage } from './pages';

type Tab = 'timeline' | 'medications' | 'members' | 'alerts' | 'settings' | 'account';
const TABS: { id: Tab; label: string; adminOnly?: boolean }[] = [
  { id: 'timeline', label: 'Overview' },
  { id: 'medications', label: 'Medicines' },
  { id: 'members', label: 'Family' },
  { id: 'alerts', label: 'Email alerts' },
  { id: 'settings', label: 'Check-in window', adminOnly: true },
  { id: 'account', label: 'Account' },
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('timeline');

  const load = useCallback(async () => {
    setError(null);
    try {
      const who = await api<Me>('/me');
      setMe(who);
      setCircle(who.membership ? await api<Circle>(`/circles/${who.membership.circleId}`) : null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        signOut();
        setMe(null);
      } else setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      if (window.location.pathname === '/callback') {
        try {
          await completeSignIn();
        } catch (err) {
          setError((err as Error).message);
          setLoading(false);
          return;
        }
      }
      if (isSignedIn()) await load();
      else setLoading(false);
    })();
  }, [load]);

  if (loading) return <Shell><p role="status">Loading…</p></Shell>;

  if (!me) {
    return (
      <Shell header={<div className="topbar"><span className="brand">Care Circle</span></div>}>
        <section className="hero">
          <h1>Know Mom's morning went fine, without calling to check.</h1>
          <p className="lead">Daily check-ins and a simple medicine log by voice on Alexa, shared with the family.</p>
          <ul className="steps">
            <li>
              <strong>She talks to Alexa.</strong> “I'm up.” “I took my blood pressure pill.”
            </li>
            <li>
              <strong>You see it here</strong>, and ask Alexa “How's Mom today?”
            </li>
            <li>
              <strong>If a check-in or medicine is missed</strong>, the family gets an email.
            </li>
          </ul>
          {error && <p role="alert" className="error">{error}</p>}
          <button className="primary big-btn" onClick={() => void signIn()}>
            Sign in
          </button>
          <p className="hint">New here? Choose “Sign up” on the next page.</p>
        </section>
        <Footer />
      </Shell>
    );
  }

  const role = me.membership?.role;
  const visibleTabs = TABS.filter((t) => !t.adminOnly || role === 'admin');

  return (
    <Shell
      header={
        <div className="topbar">
          <span className="brand">Care Circle</span>
          <span className="who">
            <strong>{me.firstName ?? 'You'}</strong>
            {role ? ` · ${role === 'admin' ? 'lead caregiver' : role === 'member' ? 'family member' : 'Care Circle looks after you'}` : ''}
          </span>
          <button className="small"
            onClick={() => {
              setMe(null);
              void signOutEverywhere();
            }}
          >
            Sign out
          </button>
        </div>
      }
    >
      {error && <p role="alert" className="error">{error}</p>}
      {!circle ? (
        <CreateCirclePage onCreated={load} />
      ) : (
        <>
          <h1>{circle.recipientFirstName}'s circle</h1>
          {circle.paused && (
            <p className="banner" role="status">
              {circle.recipientFirstName} has paused sharing. Check-ins and medicine logs are hidden and missed alerts are off.
            </p>
          )}
          <nav aria-label="Sections">
            <ul className="tabs" role="tablist">
              {visibleTabs.map((t) => (
                <li key={t.id} role="presentation">
                  <button role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                    {t.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <section role="tabpanel" aria-label={visibleTabs.find((t) => t.id === tab)?.label}>
            {tab === 'timeline' && <TimelinePage circle={circle} />}
            {tab === 'medications' && <MedicationsPage circle={circle} canEdit={role === 'admin'} />}
            {tab === 'members' && <MembersPage circle={circle} me={me} onChange={load} />}
            {tab === 'alerts' && <AlertsPage circle={circle} me={me} />}
            {tab === 'settings' && role === 'admin' && <SettingsPage circle={circle} onSaved={load} />}
            {tab === 'account' && (
              <AccountPage
                me={me}
                circle={circle}
                onDeleted={() => {
                  setMe(null);
                  void signOutEverywhere();
                }}
              />
            )}
          </section>
        </>
      )}
      <Footer />
    </Shell>
  );
}

function Shell({ children, header }: { children: React.ReactNode; header?: React.ReactNode }) {
  return (
    <>
      <a href="#main" className="skip">
        Skip to content
      </a>
      {header}
      <main id="main">{children}</main>
    </>
  );
}

function Footer() {
  return (
    <footer>
      <p>Care Circle only knows what someone tells it. It is not an emergency service; in an emergency, call 911.</p>
      <p>This is not a substitute for professional medical advice. Consult a healthcare provider for personal medical decisions.</p>
    </footer>
  );
}
