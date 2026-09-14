import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BriefDto, type DraftResponse } from '../../generate/dto/generate.dto.js';

/**
 * A saved brand.
 *
 * The same brand-level fields the form already collects, plus a slug and
 * timestamps the server owns. Article-level fields, topic and keywords, are
 * deliberately absent: they change per article, and storing them here would
 * mean loading a brand quietly overwrote whatever you were working on.
 */
export interface BrandProfile {
  /** Directory name, derived from brandName. Assigned by the server. */
  slug: string;
  brandName: string;
  brandDescription: string;
  audience?: string;
  region?: string;
  avoidTerms?: string[];
  drawbacks?: string[];
  negativeKeywords?: string[];
  callToAction?: string;
  internalLinks?: string[];
  products?: unknown[];
  style?: string;
  wordCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * The few hundred bytes needed to render one row of the library.
 *
 * Kept in its own file next to the article rather than inside it, because
 * listing a thousand articles must not mean reading a hundred megabytes.
 */
export interface SavedArticleMeta {
  id: string;
  slug: string;
  topic: string;
  title: string;
  words: number;
  /** Raw local detection score at save time. */
  score: number;
  /** The same projected onto a commercial detector's scale. */
  estimatedExternal: number;
  /** Scorecard total, or null when the article predates grading. */
  scorecard: number | null;
  delivered: boolean;
  costUsd: number;
  savedAt: number;
  note?: string;
  /**
   * Where this article was published, once it has been.
   *
   * Entered by hand rather than discovered: nothing in this app talks to
   * Shopify, so the only way it can know the live URL is if someone pastes it
   * in after publishing. Worth storing because an SEO archive you cannot
   * trace to live pages is just a folder of drafts.
   */
  url?: string;
  /** SEO fields copied up from the article so a listing can show them. */
  titleTag?: string;
  metaDescription?: string;
  seoSlug?: string;
}

export class SaveBrandDto {
  @ValidateNested()
  @Type(() => BriefDto)
  brief!: BriefDto;
}

export class SaveArticleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  topic!: string;

  /** The whole DraftResponse, sent back as the app received it. */
  @IsOptional()
  draft?: DraftResponse;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * Deleting a brand takes the article count with it.
 *
 * Not ceremony: a brand folder can hold a thousand articles that cost real
 * money, and the delete is not recoverable from inside the app. Echoing the
 * count back proves the caller looked at what they are about to remove.
 */
export class DeleteBrandDto {
  @IsInt()
  @Min(0)
  articles!: number;
}

/** Fields on a saved article that can be edited after the fact. */
export class UpdateArticleDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class MigrateBrandsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BriefDto)
  brands!: BriefDto[];
}
