import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import type { DraftResponse } from '../generate/dto/generate.dto.js';
import type { BrandProfile, SavedArticleMeta } from './dto/library.dto.js';

/**
 * Brands and the articles written for them, stored as files on the server.
 *
 * Why the server rather than the browser, which is where brand profiles used
 * to live: a saved article measures 36 to 40 KB at 700 words and around
 * 100 KB at 2,000. Browser storage gives roughly 5 MB, so the ceiling is
 * about fifty articles and it is reached by throwing an exception mid-save.
 * The target here is a thousand. It was never going to fit.
 *
 * Layout, one directory per brand:
 *
 *   <dir>/brands/<slug>/profile.json
 *   <dir>/brands/<slug>/articles/<id>.json       the full DraftResponse
 *   <dir>/brands/<slug>/articles/<id>.meta.json  a few hundred bytes
 *
 * The split into full and meta files is what makes listing usable. A brand
 * with a thousand articles is 100 MB of JSON, and reading all of it to render
 * a list of titles would take seconds and a great deal of memory. The meta
 * files total a few hundred kilobytes.
 *
 * Deliberately NOT a shared index file. One index per brand would be smaller
 * still, but a bulk job writes twenty-five articles at once and concurrent
 * read-modify-write on a single JSON file loses entries. A file per article
 * has no contention by construction.
 *
 * There is no per-user identity anywhere in here. Everything is visible to
 * anyone who can reach the server, which is what the optional
 * ACCESS_PASSWORD exists to limit.
 */

@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private get root(): string {
    return join(this.config.library.dir, 'brands');
  }

  /**
   * A brand name to a directory name.
   *
   * Also the security boundary for every path in this service. Brand names
   * arrive from HTTP, and a name of "../../etc" would otherwise write outside
   * the data directory. Restricting to a known alphabet and rejecting an
   * empty result means no caller-supplied string ever reaches a path with a
   * separator or a dot segment in it.
   */
  static slugify(name: string): string {
    const slug = name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return slug;
  }

  private brandDir(slug: string): string {
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
      throw new BadRequestException(`"${slug}" is not a valid brand id.`);
    }
    return join(this.root, slug);
  }

  // --- Brands -------------------------------------------------------------

  async saveBrand(profile: BrandProfile): Promise<BrandProfile> {
    const slug = LibraryService.slugify(profile.brandName);
    if (!slug) {
      throw new BadRequestException(
        'The brand name has no letters or digits in it, so it cannot be saved.',
      );
    }

    const dir = this.brandDir(slug);
    await mkdir(join(dir, 'articles'), { recursive: true });

    // Preserve the original creation time across an update. Losing it on
    // every save would make "oldest brand" meaningless.
    const existing = await this.readBrand(slug).catch(() => null);
    const record: BrandProfile = {
      ...profile,
      slug,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };

    await writeFile(join(dir, 'profile.json'), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  private async readBrand(slug: string): Promise<BrandProfile> {
    const raw = await readFile(join(this.brandDir(slug), 'profile.json'), 'utf8');
    return JSON.parse(raw) as BrandProfile;
  }

  async getBrand(slug: string): Promise<BrandProfile> {
    try {
      return await this.readBrand(slug);
    } catch {
      throw new NotFoundException(`No saved brand "${slug}".`);
    }
  }

  async listBrands(): Promise<Array<BrandProfile & { articles: number }>> {
    let slugs: string[];
    try {
      slugs = await readdir(this.root);
    } catch {
      // Nothing saved yet. An empty library is not an error.
      return [];
    }

    const brands: Array<BrandProfile & { articles: number }> = [];
    for (const slug of slugs) {
      try {
        const profile = await this.readBrand(slug);
        brands.push({ ...profile, articles: await this.countArticles(slug) });
      } catch {
        // A half-written directory from an interrupted save. Skipped rather
        // than failing the whole listing.
      }
    }
    return brands.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  /**
   * Delete a brand and everything written for it.
   *
   * Guarded by an explicit article count the caller has to echo back. A brand
   * folder can hold a thousand articles that cost real money to produce, and
   * an accidental DELETE on the wrong slug is not recoverable from here.
   */
  async deleteBrand(slug: string, confirmArticles: number): Promise<void> {
    const count = await this.countArticles(slug);
    if (count !== confirmArticles) {
      throw new BadRequestException(
        `That brand holds ${count} article(s), not ${confirmArticles}. ` +
          'Nothing was deleted. Re-read the brand and try again with the ' +
          'current count.',
      );
    }
    await rm(this.brandDir(slug), { recursive: true, force: true });
    this.logger.log(`deleted brand ${slug} and ${count} article(s)`);
  }

  // --- Articles -----------------------------------------------------------

  private articlesDir(slug: string): string {
    return join(this.brandDir(slug), 'articles');
  }

  private async countArticles(slug: string): Promise<number> {
    try {
      const files = await readdir(this.articlesDir(slug));
      return files.filter((file) => file.endsWith('.meta.json')).length;
    } catch {
      return 0;
    }
  }

  /**
   * Save one article under a brand.
   *
   * The brand directory is created if it is missing, so a bulk job never
   * fails on a brand that was only ever typed into a form.
   */
  async saveArticle(
    slug: string,
    draft: DraftResponse,
    extra: { topic: string; note?: string } ,
  ): Promise<SavedArticleMeta> {
    const dir = this.articlesDir(slug);
    await mkdir(dir, { recursive: true });

    const id = randomUUID().slice(0, 12);
    const meta: SavedArticleMeta = {
      id,
      slug,
      topic: extra.topic,
      title: draft.seo?.titleTag ?? extra.topic,
      words: draft.score.word_count,
      score: draft.score.ai_score,
      estimatedExternal: draft.score.estimated_external,
      scorecard: draft.scorecard?.total ?? null,
      delivered: draft.delivered ?? false,
      costUsd: draft.usage?.costUsd ?? 0,
      savedAt: Date.now(),
      note: extra.note,
      // Copied up so a listing can show and search the SEO fields without
      // opening every article. Duplication on purpose: the article file
      // remains the source of truth, and this is a cache for the list view.
      titleTag: draft.seo?.titleTag,
      metaDescription: draft.seo?.metaDescription,
      seoSlug: draft.seo?.slug,
    };

    // Body first, meta second. If the process dies between the two, the
    // listing simply does not show an article whose body is already on disk,
    // which is recoverable. The reverse would show a row that opens to
    // nothing.
    await writeFile(join(dir, `${id}.json`), JSON.stringify(draft, null, 2), 'utf8');
    await writeFile(join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  async listArticles(slug: string): Promise<SavedArticleMeta[]> {
    let files: string[];
    try {
      files = await readdir(this.articlesDir(slug));
    } catch {
      return [];
    }

    const out: SavedArticleMeta[] = [];
    for (const file of files) {
      if (!file.endsWith('.meta.json')) continue;
      try {
        out.push(JSON.parse(await readFile(join(this.articlesDir(slug), file), 'utf8')));
      } catch {
        // Unreadable meta file. Skipped.
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  async getArticle(slug: string, id: string): Promise<DraftResponse> {
    if (!/^[a-z0-9-]{1,40}$/i.test(id)) {
      throw new BadRequestException(`"${id}" is not a valid article id.`);
    }
    try {
      const raw = await readFile(join(this.articlesDir(slug), `${id}.json`), 'utf8');
      return JSON.parse(raw) as DraftResponse;
    } catch {
      throw new NotFoundException(`No saved article ${id} under "${slug}".`);
    }
  }

  /**
   * Change what can be changed after an article is filed.
   *
   * Only the metadata: the published URL and the note. The article itself is
   * a record of what was generated and stays immutable, because an archive
   * you can quietly rewrite is not an archive.
   */
  async updateArticle(
    slug: string,
    id: string,
    patch: { url?: string; note?: string },
  ): Promise<SavedArticleMeta> {
    if (!/^[a-z0-9-]{1,40}$/i.test(id)) {
      throw new BadRequestException(`"${id}" is not a valid article id.`);
    }
    const path = join(this.articlesDir(slug), `${id}.meta.json`);
    let meta: SavedArticleMeta;
    try {
      meta = JSON.parse(await readFile(path, 'utf8')) as SavedArticleMeta;
    } catch {
      throw new NotFoundException(`No saved article ${id} under "${slug}".`);
    }

    if (patch.url !== undefined) {
      const trimmed = patch.url.trim();
      if (trimmed) {
        // Only http and https. A javascript: or data: URL stored here would
        // be rendered as a link and clicked by someone on the team.
        let parsed: URL;
        try {
          parsed = new URL(trimmed);
        } catch {
          throw new BadRequestException(`"${trimmed}" is not a valid URL.`);
        }
        if (!/^https?:$/.test(parsed.protocol)) {
          throw new BadRequestException('Only http and https links can be saved.');
        }
        meta.url = parsed.toString();
      } else {
        delete meta.url;
      }
    }
    if (patch.note !== undefined) {
      meta.note = patch.note.trim() || undefined;
    }

    await writeFile(path, JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  async deleteArticle(slug: string, id: string): Promise<void> {
    if (!/^[a-z0-9-]{1,40}$/i.test(id)) {
      throw new BadRequestException(`"${id}" is not a valid article id.`);
    }
    const dir = this.articlesDir(slug);
    // Meta first this time, for the same reason in reverse: it stops showing
    // in the list immediately, and a body left behind is dead weight rather
    // than a broken row.
    await rm(join(dir, `${id}.meta.json`), { force: true });
    await rm(join(dir, `${id}.json`), { force: true });
  }
}
