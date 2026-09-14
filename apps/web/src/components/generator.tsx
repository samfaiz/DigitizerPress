'use client';

import { useCallback, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { BrandProfiles, type BrandProfile } from '@/components/brand-profiles';
import { FixList } from '@/components/fix-list';
import { HeatMapEditor } from '@/components/heat-map-editor';
import { ImproveTips } from '@/components/improve-tips';
import { WhyItWorks } from '@/components/why-it-works';
import { LsiKeywords } from '@/components/lsi-keywords';
import { ProductInput } from '@/components/product-input';
import { ProgressBar } from '@/components/progress-bar';
import { ReadabilityPanel } from '@/components/readability-panel';
import { RichEditor } from '@/components/rich-editor';
import { ScoreDial } from '@/components/score-dial';
import { ScorecardPanel } from '@/components/scorecard-panel';
import { SeoPanel } from '@/components/seo-panel';
import { TagInput } from '@/components/tag-input';
import { UsagePanel } from '@/components/usage-panel';
import {
  ApiError,
  generateDraft,
  applyFixes,
  generateOutline,
  saveArticle,
  saveBrand,
  scoreText,
} from '@/lib/api';
import type { Brief, DraftResponse, Outline, StyleId } from '@/lib/types';
import { cn } from '@/lib/utils';

const EMPTY: Brief = {
  topic: '',
  primaryKeyword: '',
  brandName: '',
  brandDescription: '',
  wordCount: 1000,
  style: 'casual',
};

/**
 * Brief, then outline, then draft.
 *
 * Three steps rather than one button, because the outline is where a bad plan
 * is cheap to fix. Regenerating an outline costs a couple of cents; discovering
 * the same problem after a full draft costs twenty times that and your time.
 */
/**
 * Brief, outline, graded article.
 *
 * Grading is not optional. There were briefly two tabs, one graded and one
 * not, and the ungraded one was the one that got used: a quality gate you can
 * skip is a gate nobody runs. Setting the pass mark to 50 is the escape hatch
 * for anyone who wants the article regardless.
 */
export function Generator() {
  const [brief, setBrief] = useState<Brief>(EMPTY);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [threshold, setThreshold] = useState(90);
  const [edited, setEdited] = useState<string | null>(null);
  const [rescore, setRescore] = useState<{ score: number; words: number } | null>(null);
  /**
   * Sentence scores for the text as it stands now.
   *
   * Separate from draft.score because that one describes the article as
   * generated, and its character offsets stop lining up the moment a sentence
   * is replaced. Null means nothing has been rewritten yet and the draft's
   * own scoring is still accurate.
   */
  const [heatScore, setHeatScore] = useState<DraftResponse['score'] | null>(null);
  const [rescoring, setRescoring] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixNote, setFixNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'outline' | 'draft' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);

  const set = <K extends keyof Brief>(key: K, value: Brief[K]) =>
    setBrief((current) => ({ ...current, [key]: value }));

  // The heat map is only drawable when its scores were measured on the text
  // currently on screen.
  const heatStale =
    draft !== null &&
    heatScore === null &&
    edited !== null &&
    edited !== draft.markdown;

  const ready =
    brief.topic.trim().length > 2 &&
    brief.primaryKeyword.trim().length > 1 &&
    brief.brandName.trim().length > 0 &&
    brief.brandDescription.trim().length > 9;

  const run = useCallback(
    async (step: 'outline' | 'draft') => {
      setBusy(step);
      setError(null);
      try {
        if (step === 'outline') {
          setDraft(null);
          const result = await generateOutline(brief);
          setOutline(result.outline);
        } else if (outline) {
          const result = await generateDraft(brief, outline, threshold, 2);
          setDraft(result);
          setEdited(result.markdown);
          setRescore(null);
          setHeatScore(null);
        }
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : 'Something went wrong.');
      } finally {
        setBusy(null);
      }
    },
    [brief, outline, threshold],
  );

  const unsupported = draft?.factFlags.filter((flag) => !flag.inBrief) ?? [];


  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        {/* ---- Step 1: the brief ---- */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">1. Brief</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Topic and angle" hint="Not just the subject. What does the piece argue?">
              <Textarea
                value={brief.topic}
                onChange={(event) => set('topic', event.target.value)}
                placeholder="How to choose a signature scent that suits Dubai's climate"
                className="min-h-16"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Primary keyword" hint="Drives the title, H1 and slug.">
                <Input
                  value={brief.primaryKeyword}
                  onChange={(event) => set('primaryKeyword', event.target.value)}
                  placeholder="niche perfumes in Dubai"
                />
              </Field>
              <Field
                label="Secondary keywords"
                hint="Type a comma or press Enter after each one. Pasting a comma-separated list splits it."
              >
                <TagInput
                  value={brief.secondaryKeywords ?? []}
                  onChange={(list) => set('secondaryKeywords', list)}
                  placeholder="best perfumes in Dubai, long lasting perfumes"
                  max={12}
                />
              </Field>
            </div>

            <Field
              label="Related terms (LSI)"
              hint="Supporting vocabulary that signals depth. Used once each, never repeated, unlike secondary keywords which need density."
            >
              <LsiKeywords
                brief={brief}
                value={brief.lsiKeywords ?? []}
                onChange={(list) => set('lsiKeywords', list)}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Brand name">
                <Input
                  value={brief.brandName}
                  onChange={(event) => set('brandName', event.target.value)}
                  placeholder="Vierro"
                />
              </Field>
              <Field label="Audience">
                <Input
                  value={brief.audience ?? ''}
                  onChange={(event) => set('audience', event.target.value)}
                  placeholder="Gen Z buyers in the UAE"
                />
              </Field>
            </div>

            <Field
              label="What the brand does"
              hint="This is the factual boundary. The writer may not claim anything about the brand that is not stated here."
            >
              <Textarea
                value={brief.brandDescription}
                onChange={(event) => set('brandDescription', event.target.value)}
                placeholder="Vierro is a modern niche fragrance house selling bold eau de parfums online across the UAE."
                className="min-h-20"
              />
            </Field>

            <BrandProfiles
              brief={brief}
              onLoad={(profile: BrandProfile) =>
                // Merge, never replace: topic and keywords belong to the
                // article being written and a profile must not wipe them.
                setBrief((current) => ({
                  ...current,
                  brandName: profile.brandName,
                  brandDescription: profile.brandDescription,
                  audience: profile.audience,
                  region: profile.region,
                  avoidTerms: profile.avoidTerms,
                  drawbacks: profile.drawbacks,
                  negativeKeywords: profile.negativeKeywords,
                  callToAction: profile.callToAction,
                  internalLinks: profile.internalLinks,
                  products: profile.products,
                  style: profile.style ?? current.style,
                  wordCount: profile.wordCount ?? current.wordCount,
                }))
              }
            />

            <Separator />
            <Field
              label="Products to feature"
              hint="Named and linked in the article where they fit. The note is all that may be said about each one."
            >
              <ProductInput
                value={brief.products ?? []}
                onChange={(list) => set('products', list)}
              />
            </Field>

            <Separator />
            <p className="text-xs font-medium">Constraints</p>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Never mention" hint="Competitors, banned claims.">
                <TagInput
                  value={brief.avoidTerms ?? []}
                  onChange={(list) => set('avoidTerms', list)}
                  placeholder="Tom Ford, cheap"
                />
              </Field>
              <Field
                label="Drawbacks to include"
                hint="Whole phrases. Balance reads more human than pure promotion."
              >
                <TagInput
                  value={brief.drawbacks ?? []}
                  onChange={(list) => set('drawbacks', list)}
                  placeholder="Niche costs more per ml"
                  max={12}
                />
              </Field>
              <Field label="Negative keywords" hint="Kept out of title and headings.">
                <TagInput
                  value={brief.negativeKeywords ?? []}
                  onChange={(list) => set('negativeKeywords', list)}
                  placeholder="perfume wholesale"
                  max={20}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Internal links" hint="URLs or page titles to work in.">
                <TagInput
                  value={brief.internalLinks ?? []}
                  onChange={(list) => set('internalLinks', list)}
                  placeholder="/collections/stone-age"
                  max={20}
                />
              </Field>
              <Field label="Call to action">
                <Input
                  value={brief.callToAction ?? ''}
                  onChange={(event) => set('callToAction', event.target.value)}
                  placeholder="Explore the collection"
                />
              </Field>
              <Field label="Word count">
                <Input
                  type="number"
                  value={brief.wordCount ?? 1000}
                  onChange={(event) => set('wordCount', Number(event.target.value))}
                  min={300}
                  max={3000}
                />
              </Field>
              <Field label="FAQ section" hint="Three or four questions at the end of the article.">
                <div className="flex h-9 items-center gap-2">
                  <Switch
                    id="faq"
                    checked={brief.includeFaq !== false}
                    onCheckedChange={(on) => set('includeFaq', on)}
                  />
                  <Label htmlFor="faq" className="text-xs font-normal">
                    {brief.includeFaq !== false ? 'Included' : 'Omitted'}
                  </Label>
                </div>
              </Field>
              <Field label="Style">
                <select
                  value={brief.style ?? 'casual'}
                  onChange={(event) => set('style', event.target.value as StyleId)}
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                >
                  <option value="casual">Casual</option>
                  <option value="standard">Standard</option>
                  <option value="simple">Simple</option>
                  <option value="academic">Academic</option>
                </select>
              </Field>
            </div>

            <Button
              className="w-full"
              disabled={!ready || busy !== null}
              onClick={() => run('outline')}
            >
              {busy === 'outline' ? 'Planning…' : 'Plan the outline'}
            </Button>
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Request failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {busy && (
          <Card>
            <CardContent className="space-y-3 pt-6">
              <ProgressBar brief={brief} active={busy === 'draft'} />
              {busy === 'outline' && (
                <>
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-full" />
                </>
              )}
              <p className="pt-1 text-xs text-muted-foreground">
                {busy === 'outline'
                  ? 'Planning the structure.'
                  : 'Writing, grading against the contract, and rewriting if it falls short. Up to two attempts, so this can take several minutes.'}
              </p>
            </CardContent>
          </Card>
        )}

        {/* ---- Step 2: the outline, editable ---- */}
        {outline && !busy && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-4">
                <CardTitle className="text-base">2. Outline</CardTitle>
                <span className="text-xs text-muted-foreground">
                  Edit anything before drafting
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="H1">
                <Input
                  value={outline.h1}
                  onChange={(event) =>
                    setOutline({ ...outline, h1: event.target.value })
                  }
                />
              </Field>

              {outline.sections.map((section, index) => (
                <div key={index} className="flex items-start gap-2">
                  <Badge variant="secondary" className="mt-2 shrink-0">
                    {section.level.toUpperCase()}
                  </Badge>
                  <div className="flex-1 space-y-1">
                    <Input
                      value={section.heading}
                      onChange={(event) => {
                        const sections = [...outline.sections];
                        sections[index] = { ...section, heading: event.target.value };
                        setOutline({ ...outline, sections });
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      {section.intent} · ~{section.targetWords}w
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 shrink-0"
                    onClick={() =>
                      setOutline({
                        ...outline,
                        sections: outline.sections.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}

              <div className="flex gap-2 pt-1">
                <Button variant="outline" onClick={() => run('outline')} disabled={busy !== null}>
                  Regenerate
                </Button>
                {(
                  <div className="flex items-center gap-2">
                    <Label className="shrink-0 text-xs">Pass mark</Label>
                    <Input
                      type="number"
                      min={50}
                      max={100}
                      value={threshold}
                      onChange={(event) => setThreshold(Number(event.target.value))}
                      className="w-20"
                    />
                  </div>
                )}
                <Button className="flex-1" onClick={() => run('draft')} disabled={busy !== null}>
                  Write and grade
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ---- Step 3: the result ---- */}
        {draft && !busy && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-4">
                <CardTitle className="text-base">3. Article</CardTitle>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    Editable. Use the buttons under the editor to copy or download.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={filing || !brief.brandName.trim()}
                    onClick={async () => {
                      setFiling(true);
                      try {
                        // The brand is saved first, so filing an article
                        // under a company typed into the form but never
                        // saved still works rather than failing on a missing
                        // folder.
                        const brand = await saveBrand(brief);
                        const meta = await saveArticle(
                          brand.slug,
                          brief.topic,
                          // Whatever is on screen now, edits included.
                          edited !== null && edited !== draft.markdown
                            ? { ...draft, markdown: edited }
                            : draft,
                        );
                        setFiled(
                          `Saved under ${brand.brandName} at ${new Date(
                            meta.savedAt,
                          ).toLocaleTimeString()}`,
                        );
                      } catch (cause) {
                        setError(
                          cause instanceof ApiError
                            ? cause.message
                            : 'Could not save to the library.',
                        );
                      } finally {
                        setFiling(false);
                      }
                    }}
                  >
                    {filing ? 'Saving…' : 'Save to library'}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {filed && (
                <p className="mb-3 border border-primary/40 bg-primary/5 p-2 text-xs">
                  {filed}. Open it from the Library tab.
                </p>
              )}
              <Tabs defaultValue="scorecard">
                <TabsList>
                  {draft && <TabsTrigger value="scorecard">Scorecard</TabsTrigger>}
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

                {draft && (
                  <TabsContent value="scorecard" className="pt-4">
                    <ScorecardPanel result={draft} />
                  </TabsContent>
                )}

                <TabsContent value="article" className="space-y-3 pt-4">
                  <RichEditor
                    markdown={draft.markdown}
                    onChange={(value) => {
                      setEdited(value);
                      // The displayed score belongs to the generated text, so
                      // it stops being true the moment anything is edited. The
                      // heat map's offsets go stale for the same reason.
                      setRescore(null);
                      setHeatScore(null);
                    }}
                    filenameBase={draft.seo.slug || 'article'}
                  />
                  {edited !== null && edited !== draft.markdown && (
                    <div className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                      <p className="flex-1 text-xs">
                        You have edited the article, so the score above is for the
                        original version.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rescoring}
                        onClick={async () => {
                          setRescoring(true);
                          try {
                            const result = await scoreText(edited);
                            setRescore({
                              score: result.ai_score,
                              words: result.word_count,
                            });
                          } catch {
                            setError('Could not rescore the edited text.');
                          } finally {
                            setRescoring(false);
                          }
                        }}
                      >
                        {rescoring ? 'Scoring…' : 'Rescore'}
                      </Button>
                    </div>
                  )}
                  {rescore && (
                    <p className="text-xs">
                      Edited version scores{' '}
                      <span className="font-medium">{rescore.score}</span> across{' '}
                      {rescore.words} words.
                    </p>
                  )}
                </TabsContent>

                {/*
                  The heat map runs on the CURRENT text, edits included, which
                  is why it reads `edited` rather than draft.markdown. Showing
                  the generated version here while the Article tab shows an
                  edited one would put two different documents behind two tabs
                  of the same card.
                */}
                <TabsContent value="heatmap" className="pt-4">
                  {heatStale ? (
                    // Offsets are only valid for the text they were measured
                    // on. Drawing the generated article's spans over an edited
                    // one highlights the wrong sentences and then rewrites the
                    // wrong sentence, so the map is withheld until it is real.
                    <div className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                      <p className="flex-1 text-xs">
                        You have edited the article since it was scored, so the
                        highlights would land on the wrong sentences.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rescoring}
                        onClick={async () => {
                          setRescoring(true);
                          try {
                            const result = await scoreText(edited ?? draft.markdown);
                            setHeatScore(result);
                            setRescore({
                              score: result.ai_score,
                              words: result.word_count,
                            });
                          } catch {
                            setError('Could not rescore the edited text.');
                          } finally {
                            setRescoring(false);
                          }
                        }}
                      >
                        {rescoring ? 'Scoring…' : 'Refresh the map'}
                      </Button>
                    </div>
                  ) : (
                    <HeatMapEditor
                      text={edited ?? draft.markdown}
                      score={heatScore ?? draft.score}
                      style={brief.style ?? 'standard'}
                      onChange={(text, score) => {
                        setEdited(text);
                        setHeatScore(score);
                        setRescore({ score: score.ai_score, words: score.word_count });
                      }}
                    />
                  )}
                </TabsContent>

                {/*
                  Both panels below are computed from data the run already
                  produced. Neither makes a model call, which is what makes
                  "fix it yourself instead of paying for another pass" an
                  honest suggestion rather than an upsell.
                */}
                <TabsContent value="improve" className="pt-4">
                  <ImproveTips
                    score={heatScore ?? draft.score}
                    compliance={draft.compliance}
                    usage={draft.usage}
                  />
                </TabsContent>

                <TabsContent value="why" className="pt-4">
                  <WhyItWorks
                    score={heatScore ?? draft.score}
                    before={draft.humanizePasses?.[0]?.score}
                  />
                </TabsContent>

                {/* The same component the Library uses. Two panels that merely
                    looked alike would eventually drift, and finding a shorter
                    meta description in the archive than the one you were shown
                    at generation time is a quiet disaster. */}
                <TabsContent value="seo" className="pt-4">
                  <SeoPanel seo={draft.seo} />
                </TabsContent>

                <TabsContent value="checks" className="space-y-4 pt-4">
                  <div>
                    <p className="pb-2 text-xs font-medium">Brief compliance</p>
                    <FixList
                      checks={draft.compliance}
                      busy={fixing}
                      onApply={async (instructions) => {
                        if (!outline) return;
                        setFixing(true);
                        setFixNote(null);
                        try {
                          const result = await applyFixes(
                            brief,
                            outline,
                            edited ?? draft.markdown,
                            instructions,
                          );
                          setFixNote(result.reason);
                          if (result.applied) {
                            // Merged rather than replaced: the scorecard,
                            // E-E-A-T and usage figures belong to the original
                            // run and would be wrong if carried over silently.
                            setDraft({
                              ...draft,
                              markdown: result.markdown,
                              score: result.score,
                              compliance: result.compliance,
                              seo: result.seo,
                            });
                            setEdited(result.markdown);
                            setRescore(null);
                            // The fix pass returned a score for the new text,
                            // so the heat map stays usable instead of going
                            // stale the way a hand edit makes it.
                            setHeatScore(result.score);
                          }
                        } catch (cause) {
                          setFixNote(
                            cause instanceof ApiError ? cause.message : 'Could not apply.',
                          );
                        } finally {
                          setFixing(false);
                        }
                      }}
                    />
                    {fixNote && (
                      <p className="pt-2 text-xs text-muted-foreground">{fixNote}</p>
                    )}
                  </div>
                  <Separator />
                  <div>
                    <p className="pb-2 text-xs font-medium">SEO readability</p>
                    <ReadabilityPanel before={draft.score.readability} />
                  </div>
                </TabsContent>

                <TabsContent value="facts" className="space-y-3 pt-4">
                  <p className="text-xs text-muted-foreground">
                    Anything here reads as a checkable claim. Items marked unsupported
                    are not traceable to your brief, and those are the ones that become
                    a correction on a live page.
                  </p>
                  {draft.factFlags.length === 0 && (
                    <p className="text-sm">No factual claims detected.</p>
                  )}
                  {draft.factFlags.map((flag, index) => (
                    <div key={index} className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          'mt-1.5 size-1.5 shrink-0 rounded-full',
                          flag.inBrief ? 'bg-emerald-500' : 'bg-amber-500',
                        )}
                      />
                      <div>
                        <p className="text-sm">{flag.text}</p>
                        <p className="text-xs text-muted-foreground">
                          {flag.kind} · {flag.inBrief ? 'in your brief' : 'not in your brief'}
                        </p>
                      </div>
                    </div>
                  ))}
                </TabsContent>

                <TabsContent value="cost" className="pt-4">
                  <UsagePanel usage={draft.usage} />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}
      </div>

      <aside className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            {draft ? (
              <>
                <div className="flex justify-center">
                  <ScoreDial score={draft.score.ai_score} label="Detection score" />
                </div>
                {draft && (
                  <p
                    className={cn(
                      'pt-3 text-center text-sm font-medium',
                      draft.delivered
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-destructive',
                    )}
                  >
                    {draft.delivered ? 'Passed' : 'Did not pass'} ·{' '}
                    {draft.scorecard.total}/100
                  </p>
                )}
                <Separator className="my-4" />
                <dl className="space-y-1.5 text-xs">
                  <Row label="Words" value={String(draft.score.word_count)} />
                  <Row label="Cost" value={`$${draft.usage.costUsd.toFixed(4)}`} />
                  <Row label="Tokens" value={draft.usage.totalTokens.toLocaleString()} />
                  <Row label="Time" value={`${Math.round(draft.elapsedMs / 1000)}s`} />
                </dl>
              </>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Fill in the brief, plan an outline, then write the article.
              </p>
            )}
          </CardContent>
        </Card>

        {draft && unsupported.length > 0 && (
          <Alert>
            <AlertTitle className="text-sm">Check these before publishing</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                {unsupported.slice(0, 5).map((flag, index) => (
                  <li key={index}>{flag.text}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {draft && draft.warnings.length > 0 && (
          <Alert>
            <AlertTitle className="text-sm">Notes</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                {draft.warnings.slice(0, 6).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </aside>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}


function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
