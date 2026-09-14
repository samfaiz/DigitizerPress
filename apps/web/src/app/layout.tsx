import type { Metadata } from 'next';
import { Geist_Mono, Montserrat } from 'next/font/google';
import { AccessPassword } from '@/components/access-password';
import { SiteNav } from '@/components/site-nav';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

// Montserrat, matching the reference. The light weights carry the display
// type; 600 and 700 do the headings.
const montserrat = Montserrat({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['200', '300', '400', '500', '600', '700'],
});
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Digitizer Press',
  description:
    'Write and humanise SEO content. Graded against a delivery contract before it ships.',
};

/**
 * Set the theme class before the first paint.
 *
 * This has to be an inline blocking script in <head>. Any React-side approach
 * runs after the first frame, so the page paints in the default theme and then
 * flips, which is the flash every badly themed site has.
 *
 * Kept deliberately tiny and defensive: localStorage throws in a private
 * window, and the whole thing is wrapped so a failure leaves the documented
 * default rather than an unstyled page.
 */
const THEME_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('digitizer-press:theme');
    var choice = stored || 'dark';
    var dark = choice === 'dark' ||
      (choice === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line react/no-danger */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className={`${montserrat.variable} ${geistMono.variable} antialiased`}>
        {/* Tooltips are used in the heat map and the metrics table, both of
            which are client components deep in the tree. */}
        <TooltipProvider delay={200}>
          {/* Renders nothing unless the server is password protected, which
              is off by default. */}
          <AccessPassword />
          <SiteNav />
          {children}
        </TooltipProvider>
      </body>
    </html>
  );
}
