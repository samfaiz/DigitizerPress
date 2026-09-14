import { splitSentences, words } from '../../humanize/pipeline/text.js';
import type {
  BriefDto,
  CitationSuggestion,
  EeatCheck,
} from '../dto/generate.dto.js';

/**
 * E-E-A-T support: Experience, Expertise, Authoritativeness, Trustworthiness.
 *
 * Support, not compliance, and the distinction is not pedantry. Most E-E-A-T
 * assessment happens off the page entirely: site reputation, author identity
 * across the web, backlinks, an About page. None of that lives in an article,
 * so nothing here can deliver it.
 *
 * What this does is score the part that IS on the page, and refuse to fake the
 * rest. Experience in particular cannot be manufactured: generated text has
 * none, and writing "we tested this for three months" when nobody did is a
 * trust violation dressed as an optimisation. So the Experience axis simply
 * fails when no genuine notes were supplied, rather than quietly passing.
 */

const occurrences = (haystack: string, needle: string): number => {
  if (!needle.trim()) return 0;
  const escaped = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (haystack.match(new RegExp(`\\b${escaped}\\b`, 'gi')) ?? []).length;
};

/** First-person plural attribution, which is how brand experience reads. */
const EXPERIENCE_VOICE =
  /\b(we(?:'ve| have| find| found|'re| are| see| tend)|in our experience|our customers|customers tell us|we notice)\b/gi;

/** Honest uncertainty. Its absence usually means overclaiming. */
const HEDGES =
  /\b(usually|often|tends? to|in most cases|generally|typically|can be|may |might |broadly|for many|some people)\b/gi;

/** Unqualified absolutes, which are almost never true and read as marketing. */
const ABSOLUTES =
  /\b(always|never|every single|guaranteed|100% of|no one|everyone|all customers|completely eliminates?)\b/gi;

const CAUSAL =
  /\b(causes?|leads? to|results? in|because of this|due to|drives?|triggers?|prevents?)\b/i;
const COMPARATIVE =
  /\b(better than|worse than|more effective|less effective|outperforms?|superior to|cheaper than|longer than)\b/i;
const HEALTH =
  /\b(skin|health|allerg|irritat|safe|toxic|sensitiv|reaction|dermat)/i;

export function findCitationSuggestions(
  brief: BriefDto,
  markdown: string,
): CitationSuggestion[] {
  const supplied = [
    brief.brandDescription,
    brief.experienceNotes ?? '',
    ...(brief.drawbacks ?? []),
    ...(brief.products ?? []).map((product) => product.note ?? ''),
  ]
    .join(' ')
    .toLowerCase();

  const out: CitationSuggestion[] = [];

  for (const sentence of splitSentences(markdown.replace(/^#{1,6}\s.*$/gm, ''))) {
    if (sentence.length < 30) continue;

    // A claim the brand made itself needs no source: it is their own account,
    // already attributed, and citing it would be circular.
    if (EXPERIENCE_VOICE.test(sentence)) {
      EXPERIENCE_VOICE.lastIndex = 0;
      continue;
    }
    EXPERIENCE_VOICE.lastIndex = 0;

    // Traceable to something the user supplied.
    const content = words(sentence).filter((word) => word.length > 5);
    if (content.length > 2) {
      const grounded =
        content.filter((word) => supplied.includes(word.toLowerCase())).length /
        content.length;
      if (grounded > 0.6) continue;
    }

    let kind: CitationSuggestion['kind'] | null = null;
    let reason = '';

    if (/\b\d+(?:\.\d+)?\s?%|\b\d[\d,]*\s?(?:times|percent)\b/.test(sentence)) {
      kind = 'statistical';
      reason = 'States a figure with no source.';
    } else if (HEALTH.test(sentence) && CAUSAL.test(sentence)) {
      kind = 'health';
      reason = 'Health or safety claim. These carry the highest trust cost if wrong.';
    } else if (COMPARATIVE.test(sentence)) {
      kind = 'comparative';
      reason = 'Compares options without evidence.';
    } else if (CAUSAL.test(sentence)) {
      kind = 'causal';
      reason = 'Asserts cause and effect as fact.';
    } else if (ABSOLUTES.test(sentence)) {
      ABSOLUTES.lastIndex = 0;
      kind = 'absolute';
      reason = 'Unqualified absolute. Softening it is usually better than sourcing it.';
    }
    ABSOLUTES.lastIndex = 0;

    if (kind) out.push({ sentence: sentence.trim(), reason, kind });
  }

  // Health first: those are the ones that cost most if wrong.
  const rank = { health: 0, statistical: 1, comparative: 2, causal: 3, absolute: 4 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 15);
}

export function checkEeat(
  brief: BriefDto,
  markdown: string,
  citations: CitationSuggestion[],
  unsupportedFactCount: number,
): EeatCheck[] {
  const body = markdown.replace(/^#{1,6}\s.*$/gm, '');
  const total = Math.max(1, splitSentences(body).length);
  const checks: EeatCheck[] = [];

  const push = (
    id: string,
    axis: EeatCheck['axis'],
    label: string,
    ok: boolean,
    detail: string,
    near = false,
  ) => checks.push({ id, axis, label, status: ok ? 'good' : near ? 'warn' : 'bad', detail });

  // --- Experience.
  const notes = brief.experienceNotes?.trim() ?? '';
  if (!notes) {
    push(
      'experience_supplied',
      'experience',
      'First-hand experience',
      false,
      'No experience notes were supplied, so the article contains none. This ' +
        'is the axis generated content cannot fake, and inventing it would be ' +
        'worse than leaving it out.',
    );
  } else {
    const noteTerms = words(notes).filter((word) => word.length > 5);
    const reflected = noteTerms.filter((term) => occurrences(markdown, term) > 0);
    const share = noteTerms.length ? reflected.length / noteTerms.length : 0;
    push(
      'experience_used',
      'experience',
      'First-hand experience',
      share >= 0.5,
      `${Math.round(share * 100)}% of your experience notes are reflected in the article.`,
      share >= 0.25,
    );

    const voiced = (body.match(EXPERIENCE_VOICE) ?? []).length;
    EXPERIENCE_VOICE.lastIndex = 0;
    push(
      'experience_attributed',
      'experience',
      'Experience is attributed',
      voiced > 0,
      voiced > 0
        ? `${voiced} first-person attribution(s), such as "we have found".`
        : 'Your experience is not attributed to the brand anywhere, so a reader cannot tell it is first-hand.',
    );
  }

  // --- Expertise.
  const lsi = brief.lsiKeywords ?? [];
  if (lsi.length > 0) {
    const used = lsi.filter((term) => occurrences(markdown, term) > 0).length;
    push(
      'expertise_vocabulary',
      'expertise',
      'Subject vocabulary',
      used / lsi.length >= 0.6,
      `${used} of ${lsi.length} related terms present.`,
      used > 0,
    );
  }
  const drawbacks = brief.drawbacks ?? [];
  push(
    'expertise_nuance',
    'expertise',
    'Acknowledges complexity',
    (body.match(HEDGES) ?? []).length >= Math.max(2, total * 0.05),
    `${(body.match(HEDGES) ?? []).length} hedged statement(s). Writing that admits ` +
      'uncertainty reads as more expert, not less.',
    (body.match(HEDGES) ?? []).length > 0,
  );

  // --- Authoritativeness.
  push(
    'authority_byline',
    'authoritativeness',
    'Attributed publisher',
    Boolean(brief.brandName),
    brief.brandName
      ? `Published as ${brief.brandName}. Organization authorship is weaker than ` +
        'a named expert, but it is honest and valid structured data.'
      : 'No publisher set.',
  );
  push(
    'authority_identity',
    'authoritativeness',
    'Verifiable identity',
    Boolean(brief.brandUrl) && (brief.brandLinks?.length ?? 0) > 0,
    brief.brandUrl
      ? `Homepage set, ${brief.brandLinks?.length ?? 0} profile link(s) for sameAs.`
      : 'No brand URL or profile links, so nothing ties this byline to a known identity.',
    Boolean(brief.brandUrl),
  );

  // --- Trustworthiness.
  push(
    'trust_facts',
    'trustworthiness',
    'No unsupported claims',
    unsupportedFactCount === 0,
    unsupportedFactCount === 0
      ? 'Every factual assertion traces back to your brief.'
      : `${unsupportedFactCount} claim(s) are not traceable to your brief.`,
    unsupportedFactCount <= 2,
  );
  push(
    'trust_balance',
    'trustworthiness',
    'Balanced coverage',
    drawbacks.length > 0,
    drawbacks.length > 0
      ? `${drawbacks.length} honest drawback(s) requested. Balance is a direct trust signal.`
      : 'No drawbacks supplied, so the article is entirely positive. Unbroken promotion reads as untrustworthy.',
  );
  const absolutes = (body.match(ABSOLUTES) ?? []).length;
  ABSOLUTES.lastIndex = 0;
  push(
    'trust_overclaiming',
    'trustworthiness',
    'No overclaiming',
    absolutes === 0,
    absolutes === 0 ? 'No unqualified absolutes.' : `${absolutes} absolute claim(s) such as "always" or "guaranteed".`,
    absolutes <= 2,
  );
  const risky = citations.filter((entry) => entry.kind === 'health').length;
  push(
    'trust_sourcing',
    'trustworthiness',
    'Claims that want a source',
    citations.length === 0,
    citations.length === 0
      ? 'Nothing flagged as needing a citation.'
      : `${citations.length} claim(s) would be stronger with a source` +
        (risky ? `, ${risky} of them health related.` : '.'),
    citations.length <= 3 && risky === 0,
  );

  return checks;
}
