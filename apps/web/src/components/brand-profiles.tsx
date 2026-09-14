'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, listBrands, saveBrand as saveBrandRemote } from '@/lib/api';
import type { Brief, Product, SavedBrand } from '@/lib/types';

/**
 * Saved brand profiles.
 *
 * Now stored on the SERVER, next to the articles written for each brand.
 * They used to live in this browser, which was fine while a profile was a few
 * hundred bytes and nothing else depended on it. Once articles are filed under
 * a brand that stopped working: the brand would live in one person's browser
 * while its articles sat on the server, and the two would drift apart the
 * first time somebody opened the tool on a different machine.
 *
 * Anything found in the old localStorage key is migrated up on first load and
 * then left alone, so nobody loses the profiles they already had.
 *
 * A profile deliberately holds only the fields that stay the same between
 * articles. Topic and keywords are per-article and saving them would mean
 * loading a profile silently overwrites what you are working on.
 */
const STORAGE_KEY = 'ai-humaniser:brand-profiles:v1';

export type BrandProfile = {
  id: string;
  label: string;
  brandName: string;
  brandDescription: string;
  audience?: string;
  region?: string;
  avoidTerms?: string[];
  drawbacks?: string[];
  negativeKeywords?: string[];
  callToAction?: string;
  internalLinks?: string[];
  products?: Product[];
  style?: Brief['style'];
  wordCount?: number;
};

/** The subset of a brief that is brand-level rather than article-level. */
export function profileFromBrief(label: string, brief: Brief): BrandProfile {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    brandName: brief.brandName,
    brandDescription: brief.brandDescription,
    audience: brief.audience,
    region: brief.region,
    avoidTerms: brief.avoidTerms,
    drawbacks: brief.drawbacks,
    negativeKeywords: brief.negativeKeywords,
    callToAction: brief.callToAction,
    internalLinks: brief.internalLinks,
    products: brief.products,
    style: brief.style,
    wordCount: brief.wordCount,
  };
}

/**
 * Read anything the browser-stored version left behind.
 *
 * Only used once, to migrate. Storage throws in a private window and can hold
 * anything if it was hand-edited, so neither is trusted.
 */
function loadLegacy(): BrandProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BrandProfile[]) : [];
  } catch {
    return [];
  }
}

function clearLegacy(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the migration already succeeded server-side.
  }
}

/** Server record to the shape this component and the form already use. */
function toProfile(brand: SavedBrand): BrandProfile {
  return {
    id: brand.slug,
    label: brand.brandName,
    brandName: brand.brandName,
    brandDescription: brand.brandDescription,
    audience: brand.audience,
    region: brand.region,
    avoidTerms: brand.avoidTerms,
    drawbacks: brand.drawbacks,
    negativeKeywords: brand.negativeKeywords,
    callToAction: brand.callToAction,
    internalLinks: brand.internalLinks,
    products: brand.products,
    style: brand.style,
    wordCount: brand.wordCount,
  };
}

interface BrandProfilesProps {
  brief: Brief;
  onLoad: (profile: BrandProfile) => void;
}

export function BrandProfiles({ brief, onLoad }: BrandProfilesProps) {
  const [profiles, setProfiles] = useState<BrandProfile[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProfiles((await listBrands()).map(toProfile));
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'Could not load saved brands.',
      );
    }
  }, []);

  // Fetching during render would break server rendering, so it happens after
  // mount and the list is simply empty on the first paint.
  useEffect(() => {
    void (async () => {
      // Lift anything the old browser-stored version left behind, once.
      // Deliberately best-effort: a failed migration must not stop the list
      // from loading, and re-running it is harmless because saving a brand
      // with the same name overwrites rather than duplicates.
      const legacy = loadLegacy();
      if (legacy.length > 0) {
        try {
          for (const profile of legacy) {
            await saveBrandRemote({ ...(profile as unknown as Brief) });
          }
          clearLegacy();
        } catch {
          // Left in place to retry on the next load.
        }
      }
      await refresh();
    })();
  }, [refresh]);

  const save = useCallback(async () => {
    if (!brief.brandName.trim()) return;
    setBusy(true);
    try {
      // The server keys on the brand name, so saving the same name updates
      // that brand rather than making a second one. That is what "save"
      // means to anyone who has used a document editor, and it is also what
      // keeps a brand and its articles pointing at each other.
      await saveBrandRemote(brief);
      await refresh();
      setName('');
      setSaving(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }, [brief, refresh]);

  const canSave = brief.brandName.trim().length > 0 && brief.brandDescription.trim().length > 9;

  return (
    <div className="space-y-2">
      {profiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {profiles.map((profile) => (
            <span
              key={profile.id}
              className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
            >
              <button
                type="button"
                className="hover:underline"
                onClick={() => onLoad(profile)}
              >
                {profile.label}
              </button>

            </span>
          ))}
        </div>
      )}

      {saving ? (
        <div className="flex gap-2">
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
              if (event.key === 'Escape') setSaving(false);
            }}
            placeholder={brief.brandName || 'Profile name'}
            className="h-8 flex-1 text-xs"
          />
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSaving(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canSave}
            onClick={() => setSaving(true)}
          >
            Save brand profile
          </Button>
          <p className="text-xs text-muted-foreground">
            {profiles.length > 0
              ? 'Click a brand to load it. Saved on the server with its articles.'
              : 'Saves the brand fields so you only fill them once, on the server with its articles.'}
          </p>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
