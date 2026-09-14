import type {
  Brief,
  ComplianceCheck,
  SeoPackage,
  UsageSummary,
  DraftResponse,
  KeywordResponse,
  HumanizeResponse,
  Outline,
  OutlineResponse,
  PublicConfig,
  SavedArticleMeta,
  SavedBrand,
  ScoreResult,
  SpanRephraseResponse,
  StyleId,
} from './types';

/**
 * Where the gateway lives.
 *
 * The plain `?? 'http://localhost:4000'` this replaces was a trap. Next.js
 * inlines NEXT_PUBLIC_* at BUILD time from .env files in apps/web, not from
 * the repo root, so a monorepo build silently produced `undefined` and the
 * fallback shipped to production. The deployed site then asked every
 * visitor's browser for a port on their own machine. Over HTTPS that is
 * mixed content: the browser blocks it and reports "not secure" while
 * insisting the certificate is valid, which sends you looking at TLS for a
 * problem that is nowhere near TLS.
 *
 * The fallback is now same-origin, which is correct for every deployment in
 * deploy/: nginx routes /api/ to the gateway on the same host. An empty base
 * makes the paths relative, so a forgotten variable still works.
 *
 * localhost is used only when the PAGE ITSELF is on localhost, which is the
 * one case where the frontend and the gateway really are on different ports.
 */
function resolveBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');

  // Server-side render, before any request. Nothing here calls the API during
  // SSR today, so this only has to be harmless.
  if (typeof window === 'undefined') return 'http://localhost:4000';

  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  return isLocal ? 'http://localhost:4000' : '';
}

const BASE = resolveBase();

/** Absolute URL for an API path. Exported so nothing re-derives the base. */
export const apiUrl = (path: string): string => `${BASE}${path}`;

/**
 * The shared access password, when the server asks for one.
 *
 * Held in localStorage rather than a cookie because there is no session and
 * no server-side identity: this is one password the whole team shares, and
 * the only job here is to stop having to retype it.
 *
 * Read on every request rather than cached in a module variable, so entering
 * it takes effect immediately and clearing it takes effect immediately.
 *
 * Nothing here runs when the server has no password set, which is the default.
 */
export const PASSWORD_STORAGE = 'digitizer-press:access-password';

export function getAccessPassword(): string | null {
  try {
    return localStorage.getItem(PASSWORD_STORAGE);
  } catch {
    return null;
  }
}

export function setAccessPassword(value: string | null): void {
  try {
    if (value) localStorage.setItem(PASSWORD_STORAGE, value);
    else localStorage.removeItem(PASSWORD_STORAGE);
  } catch {
    // Private window. It applies for this page load only.
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const password = typeof window === 'undefined' ? null : getAccessPassword();
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(password ? { 'x-access-password': password } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(
      'Cannot reach the API. Is it running on port 4000?',
      0,
    );
  }

  if (!response.ok) {
    // Nest sends { message } for most failures and an array of strings for
    // validation errors, so both shapes have to be unwrapped here.
    const body = (await response.json().catch(() => null)) as
      | { message?: string | string[]; retryAfterSeconds?: number }
      | null;
    const message = Array.isArray(body?.message)
      ? body.message.join(' ')
      : (body?.message ?? `Request failed with ${response.status}`);
    throw new ApiError(message, response.status, body?.retryAfterSeconds);
  }

  return (await response.json()) as T;
}

export const getConfig = () => request<PublicConfig>('/api/config');

export const scoreText = (text: string) =>
  request<ScoreResult>('/api/score', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });

export const humanizeText = (text: string, style: StyleId, deterministicOnly: boolean) =>
  request<HumanizeResponse>('/api/humanize', {
    method: 'POST',
    body: JSON.stringify({ text, style, deterministicOnly }),
  });

/**
 * Rewrite one sentence of a document, addressed by the offsets the scorer
 * reported for it. Not cached server-side: pressing the button twice is meant
 * to give you a second option.
 */
export const rephraseSpan = (
  text: string,
  start: number,
  end: number,
  style: StyleId,
) =>
  request<SpanRephraseResponse>('/api/rephrase-span', {
    method: 'POST',
    body: JSON.stringify({ text, start, end, style }),
  });

export const suggestKeywords = (brief: Brief) =>
  request<KeywordResponse>('/api/generate/keywords', {
    method: 'POST',
    body: JSON.stringify({ brief }),
  });

export const generateOutline = (brief: Brief) =>
  request<OutlineResponse>('/api/generate/outline', {
    method: 'POST',
    body: JSON.stringify({ brief }),
  });

/**
 * Progress for a run, keyed the same way the server keys it, so no job id
 * needs to be round-tripped before polling can start.
 */
async function progressKey(brief: Brief): Promise<string> {
  const raw = `${brief.topic ?? ''}|${brief.primaryKeyword ?? ''}|${brief.brandName ?? ''}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export const applyFixes = (
  brief: Brief,
  outline: Outline,
  markdown: string,
  instructions: string[],
) =>
  request<{
    markdown: string;
    score: ScoreResult;
    compliance: ComplianceCheck[];
    seo: SeoPackage;
    applied: boolean;
    reason: string;
    usage: UsageSummary;
  }>('/api/generate/apply-fixes', {
    method: 'POST',
    body: JSON.stringify({ brief, outline, markdown, instructions }),
  });

export const getProgress = async (brief: Brief) =>
  request<{ step: string; percent: number; elapsedMs: number; done: boolean }>(
    `/api/generate/progress/${await progressKey(brief)}`,
  );

export const generateDraft = (
  brief: Brief,
  outline: Outline,
  threshold = 90,
  maxAttempts = 2,
) =>
  request<DraftResponse>('/api/generate/draft', {
    method: 'POST',
    body: JSON.stringify({ brief, outline, threshold, maxAttempts }),
  });

/** Shared colour scale for every score readout, so they never disagree. */
export function scoreTone(score: number): {
  label: string;
  text: string;
  bg: string;
  ring: string;
  stroke: string;
} {
  if (score >= 65) {
    return {
      label: 'Likely AI',
      text: 'text-rose-600 dark:text-rose-400',
      bg: 'bg-rose-500/10',
      ring: 'ring-rose-500/30',
      stroke: 'stroke-rose-500',
    };
  }
  if (score >= 35) {
    return {
      label: 'Mixed signals',
      text: 'text-amber-600 dark:text-amber-400',
      bg: 'bg-amber-500/10',
      ring: 'ring-amber-500/30',
      stroke: 'stroke-amber-500',
    };
  }
  return {
    label: 'Likely human',
    text: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-500/10',
    ring: 'ring-emerald-500/30',
    stroke: 'stroke-emerald-500',
  };
}

export const countWords = (text: string): number =>
  (text.trim().match(/[A-Za-zÀ-ɏ'’]+/g) ?? []).length;

// --- Library -------------------------------------------------------------
//
// Brands and their articles live on the server, not in this browser. A saved
// article is 36 to 40 KB at 700 words and around 100 KB at 2,000, so browser
// storage would hold roughly fifty before throwing.

export const listBrands = () => request<SavedBrand[]>('/api/library/brands');

export const saveBrand = (brief: Brief) =>
  request<SavedBrand>('/api/library/brands', {
    method: 'POST',
    body: JSON.stringify({ brief }),
  });

export const getBrand = (slug: string) =>
  request<SavedBrand>(`/api/library/brands/${slug}`);

export const deleteBrand = (slug: string, articles: number) =>
  request<{ deleted: boolean }>(`/api/library/brands/${slug}`, {
    method: 'DELETE',
    body: JSON.stringify({ articles }),
  });

export const listArticles = (slug: string) =>
  request<SavedArticleMeta[]>(`/api/library/brands/${slug}/articles`);

export const saveArticle = (slug: string, topic: string, draft: DraftResponse) =>
  request<SavedArticleMeta>(`/api/library/brands/${slug}/articles`, {
    method: 'POST',
    body: JSON.stringify({ topic, draft }),
  });

export const getArticle = (slug: string, id: string) =>
  request<DraftResponse>(`/api/library/brands/${slug}/articles/${id}`);

export const updateArticle = (
  slug: string,
  id: string,
  patch: { url?: string; note?: string },
) =>
  request<SavedArticleMeta>(`/api/library/brands/${slug}/articles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const deleteArticle = (slug: string, id: string) =>
  request<{ deleted: boolean }>(`/api/library/brands/${slug}/articles/${id}`, {
    method: 'DELETE',
  });
