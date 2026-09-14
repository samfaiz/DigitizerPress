'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Light and dark, remembered.
 *
 * Written by hand rather than pulling in next-themes, because the whole job
 * is one class on <html> and one localStorage key, and the part that actually
 * needs care is the pre-paint script in layout.tsx rather than anything here.
 *
 * The order of operations matters and is easy to get wrong:
 *
 *  1. The inline script in layout.tsx sets the class BEFORE the first paint.
 *     Doing it in this component instead means the page renders dark, hydrates,
 *     then flips to light, which is the flash everyone has seen on a badly
 *     themed site.
 *  2. This component's own state starts as null and is filled in after mount.
 *     Reading localStorage during render would make the server output and the
 *     client output disagree, and React would complain about the mismatch on
 *     every load.
 *
 * "System" is a real third option rather than a nicety. Someone whose laptop
 * flips to dark at sunset expects this to follow, and a two-way toggle cannot
 * express that.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_KEY = 'digitizer-press:theme';

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Put the choice into effect. Exported so the pre-paint script can mirror it. */
export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

const OPTIONS: Array<{ value: ThemeChoice; label: string; title: string }> = [
  { value: 'light', label: 'Light', title: 'Always light' },
  { value: 'dark', label: 'Dark', title: 'Always dark' },
  { value: 'system', label: 'Auto', title: "Follow the device's setting" },
];

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice | null>(null);

  useEffect(() => {
    const stored = (() => {
      // Storage throws in a private window or when site data is blocked.
      try {
        return localStorage.getItem(THEME_KEY) as ThemeChoice | null;
      } catch {
        return null;
      }
    })();
    setChoice(stored ?? 'dark');
  }, []);

  // Follow the device while the choice is "system". Without this listener the
  // page only picks up a system change on the next reload, which makes "Auto"
  // look broken to the one person most likely to test it.
  useEffect(() => {
    if (choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [choice]);

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Nothing to do. The choice still applies for this page.
    }
    // Enable transitions only for the duration of the switch, so the rest of
    // the app is not paying for a transition rule on every repaint.
    document.documentElement.classList.add('theme-switching');
    applyTheme(next);
    window.setTimeout(
      () => document.documentElement.classList.remove('theme-switching'),
      200,
    );
  };

  return (
    <div
      className="flex items-center gap-0.5 border border-border p-0.5"
      role="group"
      aria-label="Colour theme"
    >
      {OPTIONS.map((option) => {
        // Before mount nothing is selected, which renders the same on the
        // server and the client and settles a frame later.
        const active = choice === option.value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={() => pick(option.value)}
            className={cn(
              'px-2 py-1 text-[11px] transition-colors',
              active
                ? 'bg-primary font-medium text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
