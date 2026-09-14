import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  DeleteBrandDto,
  SaveArticleDto,
  SaveBrandDto,
  UpdateArticleDto,
  type BrandProfile,
} from './dto/library.dto.js';
import { LibraryService } from './library.service.js';

/**
 * Saved brands and the articles written for them.
 *
 * No guard decorator here: AccessPasswordGuard is registered globally, so
 * these routes are covered along with everything else. Repeating it would
 * instantiate a second copy and imply the others are unprotected.
 *
 * These are the routes that made a password worth having. Everything else in
 * this app either costs money or hands back what the caller just sent; these
 * return work already done and stored.
 */
@Controller('api/library')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get('brands')
  brands() {
    return this.library.listBrands();
  }

  @Post('brands')
  @HttpCode(200)
  saveBrand(@Body() body: SaveBrandDto) {
    // Only the brand-level fields are kept. See BrandProfile: topic and
    // keywords belong to an article, not to a company.
    const b = body.brief;
    const profile: BrandProfile = {
      slug: '',
      brandName: b.brandName,
      brandDescription: b.brandDescription,
      audience: b.audience,
      region: b.region,
      avoidTerms: b.avoidTerms,
      drawbacks: b.drawbacks,
      negativeKeywords: b.negativeKeywords,
      callToAction: b.callToAction,
      internalLinks: b.internalLinks,
      products: b.products,
      style: b.style,
      wordCount: b.wordCount,
    };
    return this.library.saveBrand(profile);
  }

  @Get('brands/:slug')
  brand(@Param('slug') slug: string) {
    return this.library.getBrand(slug);
  }

  @Delete('brands/:slug')
  @HttpCode(200)
  async deleteBrand(@Param('slug') slug: string, @Body() body: DeleteBrandDto) {
    await this.library.deleteBrand(slug, body.articles);
    return { deleted: true, slug };
  }

  @Get('brands/:slug/articles')
  articles(@Param('slug') slug: string) {
    return this.library.listArticles(slug);
  }

  @Post('brands/:slug/articles')
  @HttpCode(200)
  saveArticle(@Param('slug') slug: string, @Body() body: SaveArticleDto) {
    if (!body.draft) {
      return { saved: false, reason: 'No article was supplied.' };
    }
    return this.library.saveArticle(slug, body.draft, {
      topic: body.topic,
      note: body.note,
    });
  }

  @Get('brands/:slug/articles/:id')
  article(@Param('slug') slug: string, @Param('id') id: string) {
    return this.library.getArticle(slug, id);
  }

  /** Set the published URL or the note. The article itself is immutable. */
  @Patch('brands/:slug/articles/:id')
  @HttpCode(200)
  updateArticle(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: UpdateArticleDto,
  ) {
    return this.library.updateArticle(slug, id, body);
  }

  @Delete('brands/:slug/articles/:id')
  @HttpCode(200)
  async deleteArticle(@Param('slug') slug: string, @Param('id') id: string) {
    await this.library.deleteArticle(slug, id);
    return { deleted: true, id };
  }
}
