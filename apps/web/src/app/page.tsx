import { Humanizer } from '@/components/humanizer';

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <header className="mb-8 space-y-2">
        <h1 className="page-title text-2xl font-bold tracking-tight sm:text-3xl">
          Humanize existing text
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Score text for machine-written signals, then rewrite it while holding the
          meaning fixed. The detector runs independently of the rewriter, so the
          score is not grading its own work.
        </p>
      </header>

      <Humanizer />

      <footer className="mt-12 max-w-2xl text-xs leading-6 text-muted-foreground">
        <p>
          Detection scores are estimates, not verdicts. Every detector, this one
          included, misfires on short passages, technical writing and text by
          non-native English writers. Do not use a percentage here as evidence
          about a person.
        </p>
      </footer>
    </main>
  );
}
