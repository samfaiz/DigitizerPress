import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { StyleId } from '../../humanize/pipeline/deterministic.js';
import type { ScoreResult } from '../../scorer/scorer.types.js';
import type { UsageSummary, Verification } from '../../humanize/dto/humanize.dto.js';

/**
 * A product to feature in the article.
 *
 * `note` is the factual boundary for this product, exactly as
 * `brandDescription` is for the brand. With the strict facts guard on, the
 * writer may not claim anything about a product that is not stated here: no
 * invented prices, ingredients, sizes or awards.
 */
export class ProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  url?: string;

  /**
   * Everything the writer may say about this product.
   *
   * Generous on purpose: paste the whole product page description if you have
   * one. More detail here is what separates a paragraph that reads as though
   * someone has handled the thing from one that could describe anything.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  // --- Concrete specifics.
  //
  // A note alone produces vague copy, because the writer has nothing precise
  // to say. Facts are what make a product paragraph read as though someone
  // has actually handled the thing. Each is still a hard boundary: what is
  // here may be stated, and nothing beyond it.

  @IsOptional()
  @IsString()
  @MaxLength(60)
  price?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  size?: string;

  /** Concrete attributes: notes, materials, specs. Not marketing adjectives. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  attributes?: string[];

  /** Who it suits, in plain terms. Drives the recommendation, not the hype. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bestFor?: string;
}

/**
 * What makes this brand's writing recognisably itself.
 *
 * Derived from real samples rather than asserted, which is the point. A rule
 * saying "vary sentence length" is my description of good writing; a profile
 * saying "opens roughly a third of sentences with a conjunction, and runs
 * two-word sentences for emphasis" is an observation about theirs.
 */
export class VoiceProfileDto {
  /** Distinguishing features, stated as observations about the samples. */
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  features!: string[];

  /** Short verbatim excerpts, used as few-shot examples in the draft prompt. */
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  excerpts!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(600)
  cadence?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  vocabulary?: string;

  /** Specific habits: punctuation, openings, recurring turns of phrase. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  quirks?: string[];
}

/**
 * NOTE ON ORDER. ProductDto and VoiceProfileDto are declared ABOVE BriefDto
 * deliberately. `emitDecoratorMetadata` writes a direct class reference for a
 * single nested object property, evaluated when the decorators run, so a class
 * defined later hits the temporal dead zone and the app fails to boot with
 * "Cannot access 'X' before initialization". TypeScript does not catch it:
 * `@Type(() => X)` is lazy, but the emitted `design:type` metadata is not.
 * Array properties are unaffected, since their metadata is just `Array`.
 */

/**
 * The content brief.
 *
 * Deliberately more than a topic box. Everything here changes the output, and
 * a field left empty is a decision the model will make on your behalf.
 */
export class BriefDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  topic!: string;

  /** The single term the page should rank for. Drives title, H1 and slug. */
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  primaryKeyword!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  secondaryKeywords?: string[];

  /**
   * Semantically related terms, conventionally called LSI keywords.
   *
   * Different job from secondary keywords, and the distinction drives how they
   * are checked. Secondary keywords are terms the page is trying to RANK for,
   * so they need placement and density. These are supporting vocabulary that
   * signals topical depth, so presence once is enough and repeating them would
   * read as stuffing.
   *
   * The name is a misnomer the industry has settled on: Google has said it
   * does not use latent semantic indexing. Covering related terms still works,
   * for the simpler reason that genuinely thorough writing contains them.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  lsiKeywords?: string[];

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  brandName!: string;

  /**
   * What the brand actually does. This is also the FACTUAL BOUNDARY: with the
   * strict facts guard on, the model may not assert anything about the brand
   * that is not stated here.
   */
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  brandDescription!: string;

  /**
   * Your genuine first-hand observations for THIS article.
   *
   * The Experience in E-E-A-T, and the only honest route to it. Generated
   * content has no experience of its own, and inventing some ("we tested this
   * for three months") is precisely the fabrication the facts guard exists to
   * stop. So it has to come from you.
   *
   * Treated as factual boundary in the same way as brandDescription: the
   * writer may use what is here and may not extend it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  experienceNotes?: string;

  /** Brand homepage, for Organization structured data. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  brandUrl?: string;

  /**
   * Profile URLs for the brand: social accounts, directory listings, a
   * Wikipedia entry. These become schema.org `sameAs`, which is how a search
   * engine ties the byline to an identity it already knows.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  brandLinks?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  audience?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  region?: string;

  // --- The three distinct kinds of "negative" ---

  /**
   * Hard exclusions. Competitors not to name, claims not to make, banned
   * phrasing. The compliance check verifies none of these appear.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  avoidTerms?: string[];

  /**
   * Honest drawbacks or caveats to work in. Balanced coverage, which also
   * reads markedly more human than unbroken promotion.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  drawbacks?: string[];

  /**
   * Search terms the page should NOT rank for. Kept out of headings, the
   * title and the meta description.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  negativeKeywords?: string[];

  /**
   * How literally to use the keywords.
   *
   * 'exact' repeats the phrase verbatim wherever it appears, which is what
   * density targets reward and what makes copy read as machine-written. Most
   * pages should be 'natural': the exact phrase in the places that carry
   * ranking weight, and variations everywhere else.
   */
  @IsOptional()
  @IsIn(['natural', 'exact'])
  keywordMode?: 'natural' | 'exact';

  // --- Author signal. A visible byline is an E-E-A-T signal that structured
  // data alone does not provide: a reader sees it, not just a crawler.

  @IsOptional()
  @IsString()
  @MaxLength(120)
  authorName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  authorRole?: string;

  /** One or two sentences on why this person or team knows the subject. */
  @IsOptional()
  @IsString()
  @MaxLength(600)
  authorBio?: string;

  /**
   * Samples of writing a HUMAN actually produced for this brand.
   *
   * The single highest-value field in the brief. Everything else in these
   * prompts describes good writing in the abstract; this demonstrates it.
   * SICO (arxiv 2305.10847) reports that extracting stylistic features from
   * real examples and few-shotting from them substantially outperforms
   * instruction lists, at essentially no cost to readability.
   *
   * Old blog posts, product descriptions, newsletters, long customer emails.
   * Anything genuinely written by a person. Twenty to forty samples is the
   * range the research uses.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  voiceSamples?: string[];

  /** The extracted profile. Built once from the samples, then reused. */
  @IsOptional()
  @ValidateNested()
  @Type(() => VoiceProfileDto)
  voiceProfile?: VoiceProfileDto;

  /**
   * Render an FAQ section into the article body, not only into the schema.
   *
   * Defaults to ON. It was optional and nothing in the UI ever set it, so the
   * FAQ existed in the structured data and nowhere a reader could see it.
   * Set false explicitly to leave it out.
   */
  @IsOptional()
  @IsBoolean()
  includeFaq?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  callToAction?: string;

  /** Where the call to action points. Linked in the closing paragraph. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  ctaUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  internalLinks?: string[];

  /** Products to feature, linked by name where a URL is given. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => ProductDto)
  products?: ProductDto[];

  @IsOptional()
  @IsInt()
  @Min(300)
  @Max(3000)
  wordCount?: number;

  @IsOptional()
  @IsIn(['standard', 'academic', 'casual', 'simple'])
  style?: StyleId;
}

export class OutlineSectionDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  heading!: string;

  @IsIn(['h2', 'h3'])
  level!: 'h2' | 'h3';

  /** One line on what this section argues. Steers the draft for this section. */
  @IsString()
  @MaxLength(500)
  intent!: string;

  @IsOptional()
  @IsInt()
  @Min(40)
  @Max(600)
  targetWords?: number;
}

export class OutlineDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  h1!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OutlineSectionDto)
  sections!: OutlineSectionDto[];
}

export class VoiceRequestDto {
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  samples!: string[];
}

export class ApplyFixesDto {
  @ValidateNested()
  @Type(() => BriefDto)
  brief!: BriefDto;

  @ValidateNested()
  @Type(() => OutlineDto)
  outline!: OutlineDto;

  @IsString()
  @MinLength(50)
  markdown!: string;

  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  instructions!: string[];
}

export class ProductDetailsDto {
  @IsString()
  @MinLength(8)
  @MaxLength(500)
  url!: string;
}

/** Step one: brief in, editable outline out. */
export class OutlineRequestDto {
  @ValidateNested()
  @Type(() => BriefDto)
  brief!: BriefDto;
}

/** Step two: brief plus outline, delivered only if it clears the gates. */
export class DraftRequestDto {
  @ValidateNested()
  @Type(() => BriefDto)
  brief!: BriefDto;

  @ValidateNested()
  @Type(() => OutlineDto)
  outline!: OutlineDto;

  /** Minimum scorecard total to deliver. Their default is 90. */
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(100)
  threshold?: number;

  /** Attempts before giving up and returning the best with its failures. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  maxAttempts?: number;
}

/**
 * A bulk job: many briefs, one run, batch pricing.
 *
 * `confirm` is not ceremony. The estimate endpoint exists so a caller can see
 * the number first, and a thousand-article job is around a hundred dollars
 * that cannot be recovered by cancelling halfway, because batches already
 * sent still bill. Requiring the flag means nobody starts one by pasting the
 * wrong payload.
 */
export class BulkRequestDto {
  @ValidateNested({ each: true })
  @Type(() => BriefDto)
  @ArrayMinSize(1)
  briefs!: BriefDto[];

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(100)
  threshold?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  maxAttempts?: number;

  /** Must be true to spend money. See the class comment. */
  @IsBoolean()
  confirm!: boolean;
}

/** Same shape without the confirmation, for pricing a job before running it. */
export class BulkEstimateDto {
  @ValidateNested({ each: true })
  @Type(() => BriefDto)
  @ArrayMinSize(1)
  briefs!: BriefDto[];
}

// --- Responses ---

export interface SeoPackage {
  /** Under 60 characters or search engines truncate it. */
  titleTag: string;
  /** Under 155 characters for the same reason. */
  metaDescription: string;
  slug: string;
  h1: string;
  imageAlt: string[];
  faq: Array<{ question: string; answer: string }>;
  /** JSON-LD for Article and FAQPage, ready to paste into a template. */
  schema: string;
  keywordUsage: Array<{ keyword: string; count: number; density: number }>;
}

export interface ComplianceCheck {
  id: string;
  label: string;
  status: 'good' | 'warn' | 'bad';
  detail: string;
  /**
   * What would fix this, if anything can.
   *
   * A report that says "2 of 3 secondary keywords used" leaves the user to
   * work out what to do about it. An action says it plainly and, where the
   * fix is mechanical, lets the UI apply it rather than describe it.
   */
  fix?: {
    label: string;
    /** 'auto' runs here; 'revise' costs a model call; 'manual' is theirs. */
    kind: 'auto' | 'revise' | 'manual';
    instruction: string;
  };
}

/**
 * Assertions that read as factual claims. With the strict guard on, anything
 * listed here that is not traceable to the brief is a problem to fix before
 * publishing, not a stylistic preference.
 */
export interface FactFlag {
  text: string;
  kind: 'statistic' | 'date' | 'superlative' | 'named-entity';
  inBrief: boolean;
}

/**
 * A claim that would be stronger with a source.
 *
 * Distinct from a FactFlag, which marks a possible fabrication. This marks
 * something plausibly true but unsupported: a citation would raise its
 * Trustworthiness rather than correct an error.
 */
export interface CitationSuggestion {
  sentence: string;
  reason: string;
  kind: 'causal' | 'comparative' | 'absolute' | 'statistical' | 'health';
}

export interface EeatCheck {
  id: string;
  axis: 'experience' | 'expertise' | 'authoritativeness' | 'trustworthiness';
  label: string;
  status: 'good' | 'warn' | 'bad';
  detail: string;
}

export interface KeywordSuggestion {
  term: string;
  /** Why it belongs, so the list can be judged rather than pasted blindly. */
  reason: string;
}

export interface KeywordResponse {
  lsiKeywords: KeywordSuggestion[];
  usage: UsageSummary;
}

export interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface DraftAttempt {
  attempt: number;
  total: number;
  band: string;
  passed: boolean;
  blockedBy: string[];
}

export interface OutlineResponse {
  outline: OutlineDto;
  estimatedWords: number;
  usage: UsageSummary;
  warnings: string[];
}

/**
 * One response shape, always graded.
 *
 * There used to be an ungraded variant alongside this. Splitting them meant
 * the cheaper, ungraded path was the one that got used, which defeated the
 * purpose of having a contract: a quality gate nobody runs is decoration.
 */
export interface DraftResponse {
  markdown: string;
  seo: SeoPackage;
  score: ScoreResult;
  compliance: ComplianceCheck[];
  factFlags: FactFlag[];
  citations: CitationSuggestion[];
  eeat: EeatCheck[];
  humanizePasses: Array<{ pass: number; score: number; accepted: boolean; note: string }>;
  verification: Verification | null;
  usage: UsageSummary;
  warnings: string[];
  elapsedMs: number;
  scorecard: import('../pipeline/scorecard.js').Scorecard;
  gates: GateResult[];
  attempts: DraftAttempt[];
  /** False when the article never cleared the threshold. Returned anyway. */
  delivered: boolean;
}
