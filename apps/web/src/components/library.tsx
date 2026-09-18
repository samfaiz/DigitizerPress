'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HeatMapEditor } from '@/components/heat-map-editor';
import { ImproveTips } from '@/components/improve-tips';
import { ReadabilityPanel } from '@/components/readability-panel';
import { RichEditor } from '@/components/rich-editor';
import { ScoreDial } from '@/components/score-dial';
import { ScorecardPanel } from '@/components/scorecard-panel';
import { SeoPanel } from '@/components/seo-panel';
import { UsagePanel } from '@/components/usage-panel';
import { WhyItWorks } from '@/components/why-it-works';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ApiError,
  deleteArticle,
  deleteBrand,
  getArticle,
  listArticles,
  listBrands,
  updateArticle,
} from '@/lib/api';
import type { DraftResponse, SavedArticleMeta, SavedBrand } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Saved brands, and the articles written for each.
 *
 * Three panes rather than three pages: brands, then that brand's articles,
 * then the article itself. Everything is on the server, so this works from a
 * different machine than the one that generated the article, which is the
 * whole reason it is not in browser storage.
 *
 * Listing is deliberately cheap. The rows come from small metadata files, not
 * from the articles, so a brand with a thousand of them still opens straight
 * away; the full article is fetched only when one is opened.
 */

const when = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

export function Library() {
  const [brands, setBrands] = useState<SavedBrand[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [articles, setArticles] = useState<SavedArticleMeta[] | null>(null);
  const [open, setOpen] = useState<{ meta: SavedArticleMeta; draft: DraftResponse } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Draft of the published URL for the open article, before it is saved. */
  const [urlDraft, setUrlDraft] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);

  const fail = (cause: unknown) =>
    setError(cause instanceof ApiError ? cause.message : 'Something went wrong.');

  const refreshBrands = useCallback(async () => {
    try {
      setBrands(await listBrands());
    } catch (cause) {
      fail(cause);
      setBrands([]);
    }
  }, []);

  // The initial load is written out rather than calling refreshBrands, for
  // two reasons. The lint rule objects to kicking off state updates from an
  // effect body, and more usefully the `alive` flag stops a slow response
  // setting state on a component the user has already navigated away from.
  // refreshBrands stays for the imperative refreshes after a delete, where
  // the component is definitely still mounted.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await listBrands();
        if (alive) setBrands(next);
      } catch (cause) {
        if (!alive) return;
        fail(cause);
        setBrands([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const openBrand = useCallback(async (next: string) => {
    setSlug(next);
    setOpen(null);
    setArticles(null);
    setError(null);
    try {
      setArticles(await listArticles(next));
    } catch (cause) {
      fail(cause);
      setArticles([]);
    }
  }, []);

  const openArticle = useCallback(
    async (meta: SavedArticleMeta) => {
      setBusy(true);
      setError(null);
      try {
        setOpen({ meta, draft: await getArticle(meta.slug, meta.id) });
        setUrlDraft(meta.url ?? '');
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // Claims the generator could not trace back to the brief. Worth surfacing
  // in the tab label: these are the ones that become a correction on a live
  // page, and an archived article is exactly where you go to check.
  const unsupported = (open?.draft.factFlags ?? []).filter((flag) => !flag.inBrief);

  const saveUrl = useCallback(async () => {
    if (!open) return;
    setSavingUrl(true);
    setError(null);
    try {
      const meta = await updateArticle(open.meta.slug, open.meta.id, {
        url: urlDraft.trim(),
      });
      setOpen({ ...open, meta });
      // Refresh the row behind it so the list shows the link too.
      setArticles(await listArticles(open.meta.slug));
    } catch (cause) {
      fail(cause);
    } finally {
      setSavingUrl(false);
    }
  }, [open, urlDraft]);

  const removeArticle = useCallback(
    async (meta: SavedArticleMeta) => {
      if (!window.confirm(`Delete "${meta.title}"? This cannot be undone.`)) return;
      setBusy(true);
      try {
        await deleteArticle(meta.slug, meta.id);
        if (open?.meta.id === meta.id) setOpen(null);
        setArticles(await listArticles(meta.slug));
        await refreshBrands();
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
    },
    [open, refreshBrands],
  );

  const removeBrand = useCallback(
    async (brand: SavedBrand) => {
      const count = brand.articles ?? 0;
      // The count goes to the server as proof of what is being removed, and
      // it is spelled out here for the same reason: a thousand articles cost
      // real money and there is no undo.
      if (
        !window.confirm(
          `Delete "${brand.brandName}" and its ${count} saved article(s)? ` +
            'This cannot be undone.',
        )
      ) {
        return;
      }
      setBusy(true);
      try {
        await deleteBrand(brand.slug, count);
        if (slug === brand.slug) {
          setSlug(null);
          setArticles(null);
          setOpen(null);
        }
        await refreshBrands();
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
    },
    [slug, refreshBrands],
  );

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        {/* --- Brands --- */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Brands</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {brands === null && (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
            {brands?.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing saved yet. Save a brand from the Write tab, then save an
                article under it.
              </p>
            )}
            {brands?.map((brand) => (
              <div key={brand.slug} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void openBrand(brand.slug)}
                  className={cn(
                    'flex-1 border-l-2 px-2 py-1.5 text-left text-sm transition-colors',
                    slug === brand.slug
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {brand.brandName}
                  <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
                    {brand.articles ?? 0}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${brand.brandName}`}
                  disabled={busy}
                  className="px-1 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => void removeBrand(brand)}
                >
                  ×
                </button>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* --- Articles, then the opened one --- */}
        <div className="space-y-6">
          {slug && (
            <Card>
              <CardHeader>
                <CardTitle>
                  Articles{articles ? ` (${articles.length})` : ''}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {articles === null && (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                )}
                {articles?.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No articles saved under this brand yet.
                  </p>
                )}
                {articles?.map((meta) => (
                  <div
                    key={meta.id}
                    className={cn(
                      'flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 px-2 py-2',
                      open?.meta.id === meta.id
                        ? 'border-primary bg-muted/40'
                        : 'border-transparent',
                    )}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void openArticle(meta)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block text-sm hover:underline">
                        {meta.title}
                      </span>
                      {/* The meta description, because scanning an SEO
                          archive by title alone tells you very little: two
                          articles on the same keyword look identical up
                          there and quite different down here. */}
                      {meta.metaDescription && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {meta.metaDescription}
                        </span>
                      )}
                    </button>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {meta.words} words
                    </span>
                    <span
                      className="text-xs tabular-nums"
                      title="Estimated on a commercial detector's scale. A projection, not a reading."
                    >
                      est {meta.estimatedExternal.toFixed(0)}
                    </span>
                    {meta.scorecard !== null && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {meta.scorecard}/100
                      </span>
                    )}
                    {meta.url && (
                      <a
                        href={meta.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={meta.url}
                        onClick={(event) => event.stopPropagation()}
                        className="text-xs text-primary underline underline-offset-2"
                      >
                        live
                      </a>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {when(meta.savedAt)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Delete ${meta.title}`}
                      disabled={busy}
                      className="text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => void removeArticle(meta)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {open && (
            <Card>
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle>{open.meta.title}</CardTitle>
                  <p className="pt-1 text-xs text-muted-foreground">
                    Saved {when(open.meta.savedAt)} · cost $
                    {open.meta.costUsd.toFixed(4)}
                  </p>
                </div>
                <ScoreDial
                  score={open.draft.score.ai_score}
                  label="Detection score"
                />
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Where it went live.
                    Typed in by hand because nothing here talks to Shopify, and
                    stored on the metadata rather than the article: the article
                    is a record of what was generated and stays immutable. */}
                <div className="space-y-1">
                  <p className="text-xs font-medium">Published URL</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={urlDraft}
                      placeholder="https://yourshop.com/blogs/news/the-post"
                      className="h-8 min-w-0 flex-1 text-xs"
                      onChange={(event) => setUrlDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveUrl();
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={savingUrl || urlDraft === (open.meta.url ?? '')}
                      onClick={() => void saveUrl()}
                    >
                      {savingUrl ? 'Saving…' : 'Save link'}
                    </Button>
                    {open.meta.url && (
                      <a
                        href={open.meta.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary underline underline-offset-2"
                      >
                        Open
                      </a>
                    )}
                  </div>
                </div>

                {/*
                  The same analysis the Write tab showed when this was
                  generated. All of it was already stored inside the saved
                  article; the library simply was not rendering it, so an
                  archived article looked far thinner than a fresh one and
                  there was no way to check later why a piece scored as it did.
                */}
                <Tabs defaultValue="scorecard">
                  <TabsList>
                    <TabsTrigger value="scorecard">Scorecard</TabsTrigger>
                    <TabsTrigger value="article">Article</TabsTrigger>
                    <TabsTrigger value="heatmap">Heat map</TabsTrigger>
                    <TabsTrigger value="improve">Improve</TabsTrigger>
                    <TabsTrigger value="why">Why this works</TabsTrigger>
                    <TabsTrigger value="seo">SEO</TabsTrigger>
                    <TabsTrigger value="checks">Checks</TabsTrigger>
                    <TabsTrigger value="facts">
                      Facts{unsupported.length > 0 ? ` (${unsupported.length})` : ''}
                    </TabsTrigger>
                    <TabsTrigger value="cost">Cost</TabsTrigger>
                  </TabsList>

                  <TabsContent value="scorecard" className="pt-4">
                    <ScorecardPanel result={open.draft} />
                  </TabsContent>

                  <TabsContent value="article" className="space-y-3 pt-4">
                    {/* Read-only in effect: edits here are not written back,
                        because a saved article is a record of what shipped.
                        Copy or download it, or re-save from the Write tab. */}
                    <RichEditor
                      markdown={open.draft.markdown}
                      filenameBase={open.draft.seo?.slug || 'article'}
                    />
                    <p className="text-xs text-muted-foreground">
                      Edits here are not saved back. This is the copy as it was
                      filed; use the buttons above to take it somewhere else.
                    </p>
                  </TabsContent>

                  <TabsContent value="heatmap" className="pt-4">
                    {/* readOnly: a saved article is a record of what shipped,
                        so a rewrite button here would spend money on a change
                        that is then discarded. */}
                    <HeatMapEditor
                      readOnly
                      text={open.draft.markdown}
                      score={open.draft.score}
                      style="standard"
                    />
                  </TabsContent>

                  <TabsContent value="improve" className="pt-4">
                    <ImproveTips
                      score={open.draft.score}
                      compliance={open.draft.compliance ?? []}
                      usage={open.draft.usage}
                    />
                  </TabsContent>

                  <TabsContent value="why" className="pt-4">
                    <WhyItWorks
                      score={open.draft.score}
                      before={open.draft.humanizePasses?.[0]?.score}
                    />
                  </TabsContent>

                  <TabsContent value="seo" className="pt-4">
                    {open.draft.seo ? (
                      <SeoPanel seo={open.draft.seo} url={open.meta.url} />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        This article was saved without an SEO package.
                      </p>
                    )}
                  </TabsContent>

                  <TabsContent value="checks" className="space-y-4 pt-4">
                    {(open.draft.compliance ?? []).length > 0 && (
                      <div className="space-y-1">
                        {open.draft.compliance.map((check) => (
                          <div key={check.id} className="flex gap-2 text-sm">
                            <span
                              className={cn(
                                'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                                check.status === 'good'
                                  ? 'bg-emerald-500'
                                  : check.status === 'warn'
                                    ? 'bg-amber-500'
                                    : 'bg-rose-500',
                              )}
                            />
                            <span className="flex-1">
                              <span className="font-medium">{check.label}</span>{' '}
                              <span className="text-muted-foreground">
                                {check.detail}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {open.draft.score.readability && (
                      <ReadabilityPanel before={open.draft.score.readability} />
                    )}
                  </TabsContent>

                  <TabsContent value="facts" className="space-y-3 pt-4">
                    {(open.draft.factFlags ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Nothing was flagged as needing a source.
                      </p>
                    ) : (
                      open.draft.factFlags.map((flag, index) => (
                        <div key={index} className="border-l-2 border-border pl-3">
                          <p className="text-sm">{flag.text}</p>
                          <p className="text-xs text-muted-foreground">
                            {flag.kind}
                            {' · '}
                            {flag.inBrief
                              ? 'Traceable to your brief.'
                              : 'Not traceable to your brief. Check before publishing.'}
                          </p>
                        </div>
                      ))
                    )}
                  </TabsContent>

                  <TabsContent value="cost" className="pt-4">
                    <UsagePanel usage={open.draft.usage} />
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
