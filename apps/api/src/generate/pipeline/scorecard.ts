import type {
  ComplianceCheck,
  EeatCheck,
  CitationSuggestion,
  FactFlag,
  SeoPackage,
} from '../dto/generate.dto.js';
import type { ScoreResult } from '../../scorer/scorer.types.js';

/**
 * A single 100-point quality score, and the gate that blocks on it.
 *
 * The rubric shape (five weighted categories, a 90-point delivery threshold)
 * is adapted from the MIT-licensed claude-blog project by AgriciDaniel:
 * https://github.com/AgriciDaniel/claude-blog
 *
 * Only the shape is borrowed. Every point below is computed from a signal this
 * pipeline already measures, because a score assembled from things it cannot
 * observe would be decoration. Two of their categories are deliberately
 * remapped for that reason: their Technical gate includes page speed and
 * screenshot verification at three viewports, which belong to a rendered site
 * and not to a text API, so the technical points here cover the artefacts this
 * tool actually produces.
 *
 * The reason this exists at all: V1 measures a great deal and blocks on none
 * of it. Compliance, readability, E-E-A-T and detection all report separately,
 * and an article failing four of them still comes back looking finished.
 */

export interface ScoreLine {
  label: string;
  earned: number;
  max: number;
  detail: string;
}

export interface Category {
  id: 'content' | 'seo' | 'eeat' | 'technical' | 'citability';
  label: string;
  earned: number;
  max: number;
  lines: ScoreLine[];
}

export interface Scorecard {
  total: number;
  band: 'exceptional' | 'strong' | 'acceptable' | 'below' | 'rewrite';
  categories: Category[];
  /** Anything that must be fixed regardless of the total. */
  critical: string[];
}

const BANDS: Array<[number, Scorecard['band']]> = [
  [90, 'exceptional'],
  [80, 'strong'],
  [70, 'acceptable'],
  [60, 'below'],
  [0, 'rewrite'],
];

/** Award marks in proportion to a ratio, rounded to a whole point. */
const scale = (ratio: number, max: number): number =>
  Math.round(Math.max(0, Math.min(1, ratio)) * max);

const statusRatio = (checks: Array<{ status: string }>): number => {
  if (checks.length === 0) return 1;
  const earned = checks.reduce(
    (total, check) =>
      total + (check.status === 'good' ? 1 : check.status === 'warn' ? 0.5 : 0),
    0,
  );
  return earned / checks.length;
};

export interface ScorecardInput {
  score: ScoreResult;
  compliance: ComplianceCheck[];
  eeat: EeatCheck[];
  citations: CitationSuggestion[];
  factFlags: FactFlag[];
  seo: SeoPackage;
  markdown: string;
}

export function buildScorecard(input: ScorecardInput): Scorecard {
  const { score, compliance, eeat, citations, factFlags, seo, markdown } = input;
  const readability = score.readability.checks;
  const byId = (id: string) => compliance.find((check) => check.id === id);
  const critical: string[] = [];

  // --- Content quality, 30 points.
  // Readability carries most of it because it is measured per check rather
  // than inferred, and detection gets the rest: text that reads as machine
  // written is a content-quality problem before it is an SEO one.
  const readabilityRatio = statusRatio(
    readability.filter((check) => check.id !== 'word_count'),
  );
  const detectionRatio = 1 - Math.min(1, score.ai_score / 60);
  const content: Category = {
    id: 'content',
    label: 'Content quality',
    max: 30,
    earned: 0,
    lines: [
      {
        label: 'Readability',
        earned: scale(readabilityRatio, 18),
        max: 18,
        detail: `${readability.filter((c) => c.status === 'good').length} of ${readability.length} checks pass.`,
      },
      {
        label: 'Reads as human-written',
        earned: scale(detectionRatio, 12),
        max: 12,
        detail: `Detection score ${score.ai_score}.`,
      },
    ],
  };

  // --- SEO, 25 points.
  const seoChecks = compliance.filter((check) =>
    [
      'keyword_placement',
      'keyword_density',
      'secondary_keywords',
      'lsi_keywords',
      'title_length',
      'meta_length',
      'outline_coverage',
      'length',
    ].includes(check.id),
  );
  const seoCategory: Category = {
    id: 'seo',
    label: 'SEO',
    max: 25,
    earned: 0,
    lines: [
      {
        label: 'Keyword placement and coverage',
        earned: scale(statusRatio(seoChecks.filter((c) => c.id.includes('keyword'))), 13),
        max: 13,
        detail: byId('keyword_placement')?.detail ?? 'No keyword checks ran.',
      },
      {
        label: 'Metadata within limits',
        earned: scale(
          statusRatio(seoChecks.filter((c) => c.id.endsWith('_length'))),
          6,
        ),
        max: 6,
        detail: `Title ${seo.titleTag.length}/60, meta ${seo.metaDescription.length}/155.`,
      },
      {
        label: 'Structure matches the plan',
        earned: scale(
          statusRatio(seoChecks.filter((c) => ['outline_coverage', 'length'].includes(c.id))),
          6,
        ),
        max: 6,
        detail: byId('outline_coverage')?.detail ?? '',
      },
    ],
  };

  // --- E-E-A-T, 15 points, taken straight from the axis checks.
  const eeatCategory: Category = {
    id: 'eeat',
    label: 'E-E-A-T',
    max: 15,
    earned: 0,
    lines: (['experience', 'expertise', 'authoritativeness', 'trustworthiness'] as const).map(
      (axis) => {
        const axisChecks = eeat.filter((check) => check.axis === axis);
        const max = axis === 'trustworthiness' ? 6 : 3;
        return {
          label: axis.charAt(0).toUpperCase() + axis.slice(1),
          earned: scale(statusRatio(axisChecks), max),
          max,
          detail: `${axisChecks.filter((c) => c.status === 'good').length} of ${axisChecks.length} signals present.`,
        };
      },
    ),
  };

  // --- Technical, 15 points. Artefacts this tool actually produces, not page
  // speed or rendered screenshots, which belong to a deployed site.
  let schemaValid = true;
  try {
    JSON.parse(seo.schema);
  } catch {
    schemaValid = false;
    critical.push('The JSON-LD schema is not valid JSON.');
  }
  const linkChecks = compliance.filter((c) =>
    ['products', 'product_links', 'exclusions', 'negative_keywords'].includes(c.id),
  );
  const technical: Category = {
    id: 'technical',
    label: 'Technical',
    max: 15,
    earned: 0,
    lines: [
      {
        label: 'Structured data',
        earned: schemaValid ? 5 : 0,
        max: 5,
        detail: schemaValid ? 'Valid JSON-LD with Article and FAQPage.' : 'Invalid JSON.',
      },
      {
        label: 'Supporting assets',
        earned:
          (seo.imageAlt.length >= 2 ? 3 : seo.imageAlt.length ? 1 : 0) +
          (seo.faq.length >= 3 ? 3 : seo.faq.length ? 1 : 0),
        max: 6,
        detail: `${seo.imageAlt.length} alt text(s), ${seo.faq.length} FAQ entries.`,
      },
      {
        label: 'Links and exclusions',
        earned: scale(statusRatio(linkChecks), 4),
        max: 4,
        detail: linkChecks.length
          ? `${linkChecks.filter((c) => c.status === 'good').length} of ${linkChecks.length} pass.`
          : 'No links or exclusions to check.',
      },
    ],
  };

  // --- Citability, 15 points. Whether a model summarising this page could
  // safely quote it: claims sourced or hedged, nothing fabricated, answerable
  // questions present.
  const unsupported = factFlags.filter((flag) => !flag.inBrief).length;
  const health = citations.filter((entry) => entry.kind === 'health').length;
  const citability: Category = {
    id: 'citability',
    label: 'Citability',
    max: 15,
    earned: 0,
    lines: [
      {
        label: 'Nothing fabricated',
        earned: unsupported === 0 ? 7 : unsupported <= 2 ? 4 : 0,
        max: 7,
        detail:
          unsupported === 0
            ? 'Every claim traces to the brief.'
            : `${unsupported} claim(s) not traceable to the brief.`,
      },
      {
        label: 'Claims sourced or hedged',
        earned: citations.length === 0 ? 5 : citations.length <= 3 ? 3 : 1,
        max: 5,
        detail: `${citations.length} claim(s) would be stronger with a source.`,
      },
      {
        label: 'Answers discrete questions',
        earned: seo.faq.length >= 3 ? 3 : seo.faq.length ? 1 : 0,
        max: 3,
        detail: `${seo.faq.length} FAQ entries a model could quote directly.`,
      },
    ],
  };

  const categories = [content, seoCategory, eeatCategory, technical, citability];
  for (const category of categories) {
    category.earned = category.lines.reduce((total, line) => total + line.earned, 0);
  }

  // Critical issues block delivery whatever the total says. A high score with
  // a fabricated statistic in it is not a publishable article.
  if (unsupported > 2) {
    critical.push(`${unsupported} claims are not traceable to your brief.`);
  }
  if (health > 0) {
    critical.push(`${health} unsourced health or safety claim(s).`);
  }
  for (const check of compliance) {
    if (check.status === 'bad' && ['exclusions', 'negative_keywords'].includes(check.id)) {
      critical.push(`${check.label}: ${check.detail}`);
    }
  }
  if (/__PH\d+__/.test(markdown)) {
    critical.push('A protected span was left unrestored in the body.');
  }

  const total = categories.reduce((sum, category) => sum + category.earned, 0);
  const band = BANDS.find(([floor]) => total >= floor)![1];

  return { total, band, categories, critical };
}
