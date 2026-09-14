'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { SeoPackage } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The full SEO package for one article.
 *
 * Extracted from the generator so the library shows exactly the same thing.
 * It matters that these are the same component rather than two that look
 * alike: the whole point of saving an article is that you come back to it
 * later to publish, and finding a shorter meta description in the archive
 * than the one you were shown at generation time would be a quiet disaster.
 *
 * Character limits are shown against Google's practical truncation points,
 * 60 for the title and 155 for the description. They are guides, not rules,
 * and the counter turns red rather than blocking anything.
 */

interface SeoPanelProps {
  seo: SeoPackage;
  /** Where the article was published, if it has been. */
  url?: string;
}

function Row({
  label,
  value,
  limit,
}: {
  label: string;
  value: string;
  limit?: number;
}) {
  const [copied, setCopied] = useState(false);
  const over = limit !== undefined && value.length > limit;

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied. The text is on screen and selectable either way.
    }
  }, [value]);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{label}</p>
        <div className="flex items-center gap-2">
          {limit !== undefined && (
            <span
              className={cn(
                'text-xs tabular-nums',
                over ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {value.length}/{limit}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
      <p className="break-words text-sm">{value}</p>
    </div>
  );
}

export function SeoPanel({ seo, url }: SeoPanelProps) {
  const [copiedSchema, setCopiedSchema] = useState(false);

  return (
    <div className="space-y-4">
      {url && (
        <div>
          <p className="pb-1 text-xs font-medium">Published at</p>
          <a
            href={url}
            target="_blank"
            // noreferrer alongside noopener because the destination is a URL
            // someone on the team typed in, and it should not learn where the
            // link came from.
            rel="noopener noreferrer"
            className="break-all text-sm text-primary underline underline-offset-2"
          >
            {url}
          </a>
        </div>
      )}

      <Row label="Title tag" value={seo.titleTag} limit={60} />
      <Row label="Meta description" value={seo.metaDescription} limit={155} />
      <Row label="Slug" value={seo.slug} />
      {seo.h1 && <Row label="H1" value={seo.h1} />}

      {seo.keywordUsage.length > 0 && (
        <div>
          <p className="pb-1 text-xs font-medium">Keyword usage</p>
          {seo.keywordUsage.map((entry) => (
            <div key={entry.keyword} className="flex justify-between gap-3 text-sm">
              <span className="truncate">{entry.keyword}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {entry.count}x · {entry.density}%
              </span>
            </div>
          ))}
        </div>
      )}

      {seo.imageAlt.length > 0 && (
        <div>
          <p className="pb-1 text-xs font-medium">Image alt text</p>
          <ul className="list-disc space-y-1 pl-4 text-sm">
            {seo.imageAlt.map((alt) => (
              <li key={alt}>{alt}</li>
            ))}
          </ul>
        </div>
      )}

      {seo.faq.length > 0 && (
        <div>
          <p className="pb-1 text-xs font-medium">FAQ</p>
          {seo.faq.map((entry) => (
            <div key={entry.question} className="pb-2">
              <p className="text-sm font-medium">{entry.question}</p>
              <p className="text-sm text-muted-foreground">{entry.answer}</p>
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium">JSON-LD schema</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(seo.schema);
                setCopiedSchema(true);
                setTimeout(() => setCopiedSchema(false), 1500);
              } catch {
                // Selectable on screen regardless.
              }
            }}
          >
            {copiedSchema ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <pre className="mt-1 max-h-56 overflow-auto border bg-muted/40 p-3 text-xs">
          {seo.schema}
        </pre>
      </div>
    </div>
  );
}
