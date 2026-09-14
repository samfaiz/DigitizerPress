import { Generator } from '@/components/generator';

export default function GeneratePage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <header className="mb-8">
        <h1 className="page-title text-2xl font-bold tracking-tight sm:text-3xl">
          Write an article
        </h1>
      </header>
      <Generator />
    </main>
  );
}
