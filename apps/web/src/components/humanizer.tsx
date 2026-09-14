'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { HeatMapEditor } from '@/components/heat-map-editor';
import { ImproveTips } from '@/components/improve-tips';
import { WhyItWorks } from '@/components/why-it-works';
import { MetricsPanel } from '@/components/metrics-panel';
import { ReadabilityPanel } from '@/components/readability-panel';
import { ScoreDial } from '@/components/score-dial';
import { UsagePanel } from '@/components/usage-panel';
import { VerificationPanel } from '@/components/verification-panel';
import { ApiError, countWords, getConfig, humanizeText, scoreText } from '@/lib/api';
import type { HumanizeResponse, PublicConfig, ScoreResult, StyleId } from '@/lib/types';
import { cn } from '@/lib/utils';

const SAMPLE = `Artificial intelligence has become a pivotal technology in the modern business landscape. It is important to note that AI plays a crucial role in driving operational efficiency across multiple sectors. Moreover, organizations increasingly leverage robust machine learning frameworks to facilitate data-driven decision making, and this comprehensive approach underscores the multifaceted nature of digital transformation. Furthermore, companies that embark on this journey will unlock significant value.`;

export function Humanizer() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [text, setText] = useState('');
  const [style, setStyle] = useState<StyleId>('standard');
  const [deterministicOnly, setDeterministicOnly] = useState(false);

  const [scoreOnly, setScoreOnly] = useState<ScoreResult | null>(null);
  const [result, setResult] = useState<HumanizeResponse | null>(null);
  const [busy, setBusy] = useState<'score' | 'humanize' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Could not load configuration.'),
      );
  }, []);

  const words = useMemo(() => countWords(text), [text]);
  const maxWords = config?.maxWords ?? 1500;
  const overLimit = words > maxWords;
  const tooShort = text.trim().length < 40;

  const run = useCallback(
    async (mode: 'score' | 'humanize') => {
      setBusy(mode);
      setError(null);
      try {
        if (mode === 'score') {
          setResult(null);
          setScoreOnly(await scoreText(text));
        } else {
          setScoreOnly(null);
          setResult(await humanizeText(text, style, deterministicOnly));
        }
      } catch (cause) {
        const message =
          cause instanceof ApiError
            ? cause.retryAfterSeconds
              ? `${cause.message} Try again in ${Math.ceil(cause.retryAfterSeconds / 60)} minute(s).`
              : cause.message
            : 'Something went wrong.';
        setError(message);
      } finally {
        setBusy(null);
      }
    },
    [text, style, deterministicOnly],
  );

  const copy = useCallback(async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.humanized);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [result]);

  // The score panel reads from whichever run produced it, so the layout does
  // not have to branch between "scored only" and "fully rewritten".
  const before = result?.before ?? scoreOnly;
  const after = result?.after;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="text-base">Your text</CardTitle>
              <span
                className={cn(
                  'text-xs tabular-nums',
                  overLimit ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {words} / {maxWords} words
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste the text you want to check or rewrite."
              className="min-h-64 resize-y font-mono text-sm leading-6"
              spellCheck={false}
            />

            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="style" className="text-xs">
                  Style
                </Label>
                <Select value={style} onValueChange={(value) => setStyle(value as StyleId)}>
                  <SelectTrigger id="style" className="w-44">
                    <SelectValue>
                      {(value) =>
                        config?.styles.find((option) => option.id === value)?.label ??
                        'Standard'
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(config?.styles ?? []).map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2 pb-2">
                <Switch
                  id="deterministic"
                  checked={deterministicOnly}
                  onCheckedChange={setDeterministicOnly}
                />
                <Label htmlFor="deterministic" className="text-xs font-normal">
                  Rules only, no model
                </Label>
              </div>

              <div className="ml-auto flex gap-2 pb-1">
                <Button
                  variant="outline"
                  disabled={busy !== null || tooShort || overLimit}
                  onClick={() => run('score')}
                >
                  {busy === 'score' ? 'Checking…' : 'Check score'}
                </Button>
                <Button
                  disabled={busy !== null || tooShort || overLimit}
                  onClick={() => run('humanize')}
                >
                  {busy === 'humanize' ? 'Rewriting…' : 'Humanize'}
                </Button>
              </div>
            </div>

            {text.length === 0 && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                onClick={() => setText(SAMPLE)}
              >
                Load a sample paragraph
              </button>
            )}
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
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </CardContent>
          </Card>
        )}

        {(result || scoreOnly) && !busy && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-4">
                <CardTitle className="text-base">
                  {result ? 'Result' : 'Analysis'}
                </CardTitle>
                {result && (
                  <Button size="sm" variant="ghost" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue={result ? 'output' : 'heatmap'}>
                <TabsList>
                  {result && <TabsTrigger value="output">Rewritten</TabsTrigger>}
                  <TabsTrigger value="heatmap">Heat map</TabsTrigger>
                  <TabsTrigger value="improve">Improve</TabsTrigger>
                  <TabsTrigger value="signals">Signals</TabsTrigger>
                  <TabsTrigger value="why">Why this works</TabsTrigger>
                  <TabsTrigger value="seo">SEO</TabsTrigger>
                  {result && <TabsTrigger value="passes">Passes</TabsTrigger>}
                  {result?.verification && (
                    <TabsTrigger value="detectors">Detectors</TabsTrigger>
                  )}
                  {result && <TabsTrigger value="cost">Cost</TabsTrigger>}
                </TabsList>

                {result && (
                  <TabsContent value="output" className="pt-4">
                    <p className="whitespace-pre-wrap text-sm leading-7">
                      {result.humanized}
                    </p>
                  </TabsContent>
                )}

                <TabsContent value="heatmap" className="pt-4">
                  {(after ?? before) && (
                    <HeatMapEditor
                      text={result ? result.humanized : text}
                      score={(after ?? before)!}
                      style={style}
                      onChange={(next, nextScore) => {
                        // A rewrite lands wherever the map was drawn from. On
                        // a humanized result that is the output, and the
                        // before-and-after comparison stays meaningful because
                        // only the "after" half moves.
                        if (result) {
                          setResult({ ...result, humanized: next, after: nextScore });
                        } else {
                          setText(next);
                          setScoreOnly(nextScore);
                        }
                      }}
                    />
                  )}
                </TabsContent>

                {/* No compliance checks on this page: the humanizer is given
                    text, not a brief, so there is nothing to check it against. */}
                <TabsContent value="improve" className="pt-4">
                  {(after ?? before) && (
                    <ImproveTips
                      score={(after ?? before)!}
                      compliance={[]}
                      usage={result?.usage}
                    />
                  )}
                </TabsContent>

                <TabsContent value="why" className="pt-4">
                  {(after ?? before) && (
                    <WhyItWorks
                      score={(after ?? before)!}
                      before={result ? result.before.ai_score : undefined}
                    />
                  )}
                </TabsContent>

                <TabsContent value="signals" className="pt-4">
                  {before && (
                    <MetricsPanel before={before.metrics} after={after?.metrics} />
                  )}
                </TabsContent>

                <TabsContent value="seo" className="pt-4">
                  {before && (
                    <ReadabilityPanel
                      before={before.readability}
                      after={after?.readability}
                    />
                  )}
                </TabsContent>

                {result && (
                  <TabsContent value="passes" className="space-y-2 pt-4">
                    <p className="pb-1 text-xs text-muted-foreground">
                      Each pass is a full rewrite that is kept only if it lowers the
                      score without changing what the text says.
                    </p>
                    {result.iterations.map((iteration) => (
                      <div
                        key={iteration.pass}
                        className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
                      >
                        <Badge variant={iteration.accepted ? 'default' : 'secondary'}>
                          Pass {iteration.pass}
                        </Badge>
                        <span className="tabular-nums">{iteration.score}% AI</span>
                        <span className="text-xs text-muted-foreground">
                          {iteration.note}
                        </span>
                      </div>
                    ))}
                  </TabsContent>
                )}
                {result?.verification && (
                  <TabsContent value="detectors" className="pt-4">
                    <VerificationPanel verification={result.verification} />
                  </TabsContent>
                )}

                {result && (
                  <TabsContent value="cost" className="pt-4">
                    <UsagePanel usage={result.usage} />
                  </TabsContent>
                )}
              </Tabs>
            </CardContent>
          </Card>
        )}
      </div>

      <aside className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            {before ? (
              <div className="flex items-start justify-center gap-6">
                <ScoreDial
                  score={before.ai_score}
                  label={after ? 'Before' : 'Detection score'}
                  size={after ? 128 : 156}
                />
                {after && (
                  <ScoreDial
                    score={after.ai_score}
                    label="After"
                    compareTo={before.ai_score}
                    size={128}
                  />
                )}
              </div>
            ) : (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Paste some text and run a check to see its score.
              </div>
            )}

            {before && (
              <>
                <Separator className="my-4" />
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Words</dt>
                    <dd className="tabular-nums">{before.word_count}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Confidence</dt>
                    <dd className="tabular-nums">
                      {(before.confidence * 100).toFixed(0)}%
                    </dd>
                  </div>
                  {result && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Meaning check</dt>
                      <dd
                        className={cn(
                          result.fidelity.judge?.verdict === 'same' &&
                            'text-emerald-600 dark:text-emerald-400',
                          result.fidelity.judge?.verdict === 'drifted' &&
                            'text-destructive',
                        )}
                      >
                        {result.fidelity.judge?.verdict === 'same'
                          ? 'meaning held'
                          : result.fidelity.judge?.verdict === 'drifted'
                            ? 'meaning changed'
                            : 'not checked'}
                      </dd>
                    </div>
                  )}
                  {result && result.usage.costUsd > 0 && (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Cost</dt>
                      <dd className="tabular-nums">
                        ${result.usage.costUsd.toFixed(4)}{' '}
                        <span className="text-muted-foreground">
                          / {result.usage.totalTokens.toLocaleString()} tok
                        </span>
                      </dd>
                    </div>
                  )}
                  {result && result.fidelity.topicalSimilarity !== null && (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Topical overlap</dt>
                      <dd className="tabular-nums">
                        {result.fidelity.topicalSimilarity.toFixed(2)}
                      </dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Detector</dt>
                    <dd>{before.backend}</dd>
                  </div>
                </dl>
              </>
            )}
          </CardContent>
        </Card>

        {result && result.warnings.length > 0 && (
          <Alert>
            <AlertTitle className="text-sm">Read the score with these in mind</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {config && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">System</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Rewriter</dt>
                  <dd className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        config.provider.live ? 'bg-emerald-500' : 'bg-amber-500',
                      )}
                    />
                    {config.provider.name}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Scorer</dt>
                  <dd className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        config.scorer.ok ? 'bg-emerald-500' : 'bg-destructive',
                      )}
                    />
                    {config.scorer.detail?.backend ?? 'offline'}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Calibrated</dt>
                  <dd>{config.scorer.detail?.calibrated ? 'yes' : 'priors only'}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Optimising</dt>
                  <dd
                    className={cn(
                      config.detectors.primary === 'local' &&
                        config.detectors.verify.length > 0 &&
                        'text-amber-600 dark:text-amber-400',
                    )}
                  >
                    {config.detectors.primary}
                  </dd>
                </div>
                {config.detectors.verify.length > 0 && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Verifying</dt>
                    <dd className="text-right">{config.detectors.verify.join(', ')}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Hourly limit</dt>
                  <dd className="tabular-nums">{config.rateLimitPerHour}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        )}
      </aside>
    </div>
  );
}
