import { Library } from '@/components/library';

export default function LibraryPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <header className="mb-8">
        <h1 className="page-title text-2xl font-bold tracking-tight sm:text-3xl">
          Library
        </h1>
        <p className="pt-2 max-w-2xl text-sm text-muted-foreground">
          Every article you saved, grouped by the brand it was written for.
          Stored on the server rather than in this browser, so it survives
          clearing site data and opens from any machine on the team.
        </p>
      </header>
      <Library />
    </main>
  );
}
