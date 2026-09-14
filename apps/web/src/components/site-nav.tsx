'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/', label: 'Humanize' },
  { href: '/generate', label: 'Write' },
  { href: '/library', label: 'Library' },
];

/**
 * The accent appears here and on primary actions, nowhere else.
 *
 * The reference site uses one yellow against black, and it works because it is
 * rare. Spread across every heading and border it would stop meaning anything,
 * so it marks only where you are and what you can do next.
 */
export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="wordmark py-4 text-sm text-primary">
          Digitizer<span className="text-foreground">Press</span>
        </Link>
        <div className="flex items-center gap-1">
          {LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'border-b-2 px-3 py-4 text-sm transition-colors',
                  active
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
        <div className="ml-auto py-2">
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
