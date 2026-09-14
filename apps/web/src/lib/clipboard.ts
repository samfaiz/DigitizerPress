import { marked } from 'marked';
import TurndownService from 'turndown';

/**
 * Markdown and HTML conversion, plus the clipboard write that makes
 * paste-into-Shopify work.
 */

marked.setOptions({ gfm: true, breaks: false });

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
});

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Copy content so it arrives in a rich text editor with formatting intact.
 *
 * This is the whole trick, and it is not obvious. Pasting markdown into
 * Shopify, WordPress or Google Docs gives you literal asterisks and hash
 * marks, because those editors read the clipboard's `text/html` flavour and
 * markdown is plain text. Writing both flavours means a rich editor takes the
 * HTML and keeps the headings, bold and links, while a plain editor still gets
 * readable markdown from `text/plain`.
 */
export async function copyRich(html: string, plain: string): Promise<void> {
  // ClipboardItem is unavailable outside a secure context, and Safari has
  // historically been fussy about it, so plain text is the fallback rather
  // than an error.
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    await navigator.clipboard.writeText(plain);
    return;
  }

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(plain);
  }
}

/** Trigger a download without a server round trip. */
export function download(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * A full HTML document, for the download and for pasting into a raw HTML
 * field. The inline styles matter: a bare fragment pasted into a CMS that
 * strips stylesheets loses its structure entirely.
 */
export function toStandaloneHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title.replace(/[<>&]/g, '')}</title>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Wrap the article as a file Word will open with its formatting intact.
 *
 * There is no .docx being written here, and that is the right call. A real
 * .docx is a zip of several XML parts and needs a library; Word has opened
 * HTML saved with a .doc extension for twenty years, and so do Google Docs and
 * Pages. The result is a genuinely editable document with real heading styles,
 * not a screenshot of one.
 *
 * Three details make the difference between this working and producing a wall
 * of unstyled text:
 *
 *  - The Office namespaces and the ProgId meta tell Word to treat the file as
 *    a document rather than a web page, which is what preserves the outline
 *    and lets Word's navigation pane see the headings.
 *  - The charset meta must come first, or Word guesses an encoding and any
 *    curly quote or dirham sign arrives mangled.
 *  - Heading sizes are set in points rather than pixels. Word maps points to
 *    its own styles; pixels it largely ignores.
 */
export function toWordHtml(title: string, bodyHtml: string): string {
  const safeTitle = title.replace(/[<>&]/g, '');
  return `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<meta name="ProgId" content="Word.Document">
<meta name="Generator" content="Microsoft Word">
<title>${safeTitle}</title>
<style>
  @page { margin: 2.5cm; }
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.5; }
  h1 { font-size: 20pt; font-weight: 700; margin: 0 0 12pt; }
  h2 { font-size: 15pt; font-weight: 700; margin: 18pt 0 8pt; }
  h3 { font-size: 12.5pt; font-weight: 700; margin: 14pt 0 6pt; }
  p { margin: 0 0 10pt; }
  ul, ol { margin: 0 0 10pt 18pt; }
  a { color: #0563c1; }
  blockquote { margin: 0 0 10pt 18pt; color: #444; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}
