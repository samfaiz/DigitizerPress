'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getAccessPassword, getConfig, setAccessPassword } from '@/lib/api';

/**
 * Ask for the shared password, once, and only when the server wants one.
 *
 * Renders nothing at all on a server with no password set, which is the
 * default and the right setup on a single machine. So this component is
 * invisible until someone deliberately turns protection on.
 *
 * The check is driven by the server's own answer rather than a build-time
 * flag. `/api/config` is the one unguarded route precisely so the app can ask
 * "do you want a password?" before it has one, which means the same frontend
 * build works against an open local server and a protected shared one.
 *
 * Be honest in the copy as well as the code: this is one password the team
 * shares, not a login. Nothing here knows who you are, so nothing can
 * attribute a saved or deleted article to a person.
 */
export function AccessPassword() {
  const [needed, setNeeded] = useState(false);
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probe = useCallback(async () => {
    try {
      const config = await getConfig();
      setNeeded(config.passwordRequired === true && !getAccessPassword());
    } catch {
      // Server unreachable. The pages themselves report that; this should not
      // also shout about it.
      setNeeded(false);
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const submit = useCallback(async () => {
    const password = value.trim();
    if (!password) return;
    setChecking(true);
    setError(null);
    setAccessPassword(password);
    try {
      // Verified against a protected route, not just stored. Storing an
      // unchecked password means every later screen fails with a confusing
      // 401 instead of this box saying it was wrong.
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/library/brands`,
        { headers: { 'x-access-password': password } },
      );
      if (response.status === 401) {
        setAccessPassword(null);
        setError('That password was not accepted.');
        return;
      }
      setNeeded(false);
      // Pages fetched their data before the password existed, so the simplest
      // correct thing is to start again with it in place.
      window.location.reload();
    } catch {
      setAccessPassword(null);
      setError('Could not reach the server to check the password.');
    } finally {
      setChecking(false);
    }
  }, [value]);

  if (!needed) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4">
      <div className="w-full max-w-md space-y-4 border border-border bg-card p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Password</h2>
          <p className="text-sm text-muted-foreground">
            This server is shared, so it asks for a password before it will show
            saved brands and articles or spend anything on generation.
          </p>
        </div>

        <Input
          type="password"
          autoFocus
          value={value}
          placeholder="Enter the team password"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />

        {error && <p className="text-xs text-destructive">{error}</p>}

        <Button
          disabled={checking || value.trim().length === 0}
          onClick={() => void submit()}
        >
          {checking ? 'Checking…' : 'Unlock'}
        </Button>

        <p className="text-xs text-muted-foreground">
          One password for everyone on the team, remembered in this browser. It
          is not a login: nothing records who saved or deleted an article.
          Whoever runs the server sets it as <code>ACCESS_PASSWORD</code>, and
          leaving that blank turns this off entirely.
        </p>
      </div>
    </div>
  );
}
