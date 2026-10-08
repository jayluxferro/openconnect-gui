import { useState, useEffect, useRef } from 'react';
import { Badge } from './components/ui/badge';
import { Separator } from './components/ui/separator';
import { Loader2, CheckCircle2, XCircle, AlertTriangle, Shield } from 'lucide-react';
import { Button } from './components/ui/button';

// System checks are executed in main.js and pushed once, as a completed batch
// of [{check, ok, detail}], over the ocSplash bridge (splash-preload.js).
// The bridge has no per-check events, so the old streaming cadence (one check
// appearing every ~300ms, spinner first, then its pass/fail flip and progress
// bump) is recreated here when the batch lands, keeping the splash visually
// identical to the per-check IPC version.
const REVEAL_MS = 300;

// The bridge shape carries no free-text failure line, so the exact copy
// main.js used to push via 'splash-error' lives here, keyed by the check
// names main sends ('OpenConnect Binary', 'Expect Binary'); anything else
// falls back to the pushed detail text.
const FAILURE_COPY = [
  {
    check: 'OpenConnect Binary',
    message: 'OpenConnect is not installed. Install with: brew install openconnect',
  },
  {
    check: 'Expect Binary',
    message: 'Expect is not installed. It should be pre-installed on macOS. Try: brew install expect',
  },
];

function failureMessage(failed) {
  for (const { check, message } of FAILURE_COPY) {
    if (failed.some((result) => result.check === check)) {
      return message;
    }
  }
  return failed.map((result) => `${result.check}: ${result.detail}`).join('\n');
}

// Sudo arrives ok:true even when the privilege is missing — main puts the
// caveat in the detail string. Surface that as the old warning state so the
// soft-pass stays visually distinct from a real pass.
const SUDO_CAVEAT = /will prompt when connecting/i;

function statusForResult(result) {
  if (!result.ok) return 'error';
  if (result.check === 'Sudo Privileges' && SUDO_CAVEAT.test(result.detail)) {
    return 'warning';
  }
  return 'success';
}

function Splash() {
  const [statusText, setStatusText] = useState('Initializing...');
  const [progress, setProgress] = useState(0);
  const [checks, setChecks] = useState([]);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState('');
  const revealTimers = useRef([]);
  const resultsReceived = useRef(false);

  useEffect(() => {
    const oc = window.ocSplash;
    if (!oc) {
      // main.js creates this window with splash-preload.js; landing here means
      // that wiring is broken — the same dead-end as the old direct-electron
      // access throwing under contextIsolation. Nothing useful runs without it.
      console.error('ocSplash bridge unavailable — splash-preload.js not loaded');
      return;
    }

    // Badge version (#33) — an IPC round-trip, so it resolves a beat after
    // first paint; the badge stays hidden until then rather than showing a
    // hard-coded value that goes stale. A failed fetch must not block the
    // checks, it just leaves the badge off.
    oc.version?.().then(setVersion).catch((err) => {
      console.error('Failed to fetch app version:', err);
    });

    // Subscribe before signalling loaded() so the results push can never
    // outrun the listener.
    oc.onChecks((results) => {
      // onChecks registers a push listener with no unsubscribe, so guard
      // against a second delivery (e.g. a re-registered listener in dev)
      // restarting the reveal.
      if (resultsReceived.current) return;
      resultsReceived.current = true;

      const timers = revealTimers.current;
      results.forEach((result, index) => {
        timers.push(setTimeout(() => {
          setChecks(prev => [...prev, { name: result.check, status: 'checking', message: '' }]);
        }, index * REVEAL_MS));

        timers.push(setTimeout(() => {
          // Reveal is strictly in-order append, so position identifies the row.
          setChecks(prev => prev.map((check, i) =>
            i === index
              ? { ...check, status: statusForResult(result), message: result.detail }
              : check
          ));
          setProgress(Math.round(((index + 1) / results.length) * 100));
        }, (index + 1) * REVEAL_MS));
      });

      timers.push(setTimeout(() => {
        // Today's failure paths also let progress reach 100 but suppressed the
        // continue button via the error state — same gate below.
        const failed = results.filter((result) => !result.ok);
        if (failed.length > 0) {
          setStatusText('Setup Required');
          setError({
            message: failureMessage(failed),
            action: failed.some((result) => result.check === 'OpenConnect Binary')
              ? 'install-openconnect'
              : null,
          });
        } else {
          setStatusText('System checks completed successfully!');
        }
      }, (results.length + 1) * REVEAL_MS));
    });

    oc.loaded();

    return () => {
      revealTimers.current.forEach(clearTimeout);
    };
  }, []);

  const handleInstallClick = () => {
    window.ocSplash?.openInstaller();
  };

  const handleLoginClick = () => {
    window.ocSplash?.ready();
  };

  const getIconForStatus = (status) => {
    switch (status) {
      case 'checking':
        return <Loader2 className="h-5 w-5 animate-spin" />;
      case 'success':
        return <CheckCircle2 className="h-5 w-5" />;
      case 'error':
        return <XCircle className="h-5 w-5" />;
      case 'warning':
        // Reachable via statusForResult: sudo arrives ok:true with a caveat
        // in its detail, and that soft-pass keeps the old warning triangle.
        return <AlertTriangle className="h-5 w-5" />;
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-8 text-center">
        <div className="space-y-4">
          <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border-2 border-foreground">
            <Shield className="h-12 w-12" />
          </div>
          <h1 className="text-4xl font-bold">OpenConnect VPN</h1>
          {version && <Badge variant="outline">Version {version}</Badge>}
        </div>

        <Separator />

        <div className="space-y-6">
          <div className="text-lg font-medium">{statusText}</div>

          <div className="space-y-2">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-foreground transition-all duration-300"
                style={{ width: `${progress}%` }}
              ></div>
            </div>
            <div className="text-sm text-muted-foreground">{progress}%</div>
          </div>

          <div className="space-y-3">
            {checks.map((check, index) => (
              <div
                key={index}
                className="flex items-center gap-3 rounded-md border bg-card p-3 text-left"
              >
                <div
                  className={
                    check.status === 'checking'
                      ? 'text-muted-foreground'
                      : check.status === 'success'
                      ? 'text-foreground'
                      : check.status === 'error'
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  }
                >
                  {getIconForStatus(check.status)}
                </div>
                <div className="flex-1">
                  <div className="font-medium">{check.name}</div>
                  {check.message && (
                    <div className="text-xs text-muted-foreground">{check.message}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {error && (
            <div className="space-y-3 rounded-md border-2 border-destructive bg-destructive/10 p-4">
              <div className="font-semibold">Setup Required</div>
              <div className="text-sm">{error.message}</div>
              {error.action === 'install-openconnect' && (
                <Button onClick={handleInstallClick} className="w-full">
                  Install OpenConnect
                </Button>
              )}
            </div>
          )}

          {progress === 100 && !error && (
            <Button onClick={handleLoginClick} size="lg" className="w-full">
              Continue to OpenConnect
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default Splash;
