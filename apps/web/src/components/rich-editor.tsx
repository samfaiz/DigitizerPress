'use client';

import Link from '@tiptap/extension-link';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  copyRich,
  download,
  htmlToMarkdown,
  markdownToHtml,
  toStandaloneHtml,
  toWordHtml,
} from '@/lib/clipboard';
import { cn } from '@/lib/utils';

interface RichEditorProps {
  markdown: string;
  /** Fires on every edit, so the parent can re-score the changed text. */
  onChange?: (markdown: string) => void;
  filenameBase?: string;
}

/**
 * A rich text editor over the generated article.
 *
 * Built on TipTap, which wraps ProseMirror, the same engine behind Shopify's
 * and WordPress's editors. That matters for more than familiarity: a
 * contentEditable box with `document.execCommand` is quick to write but
 * produces inconsistent markup across browsers and the API is deprecated.
 *
 * Editing happens in HTML and converts back to markdown on the way out, so the
 * article stays round-trippable and the scorer keeps receiving plain text.
 */
export function RichEditor({
  markdown,
  onChange,
  filenameBase = 'article',
}: RichEditorProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  const editor = useEditor({
    // Next renders this on the server first, and ProseMirror needs a DOM.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true }),
    ],
    content: markdownToHtml(markdown),
    editorProps: {
      attributes: {
        class:
          'prose-editor min-h-[24rem] max-w-none rounded-md border p-4 focus:outline-none',
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange?.(htmlToMarkdown(instance.getHTML()));
    },
  });

  // Replace the content when a new article arrives, but never while the user
  // is mid-edit: overwriting someone's typing is the worst possible bug here.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const incoming = markdownToHtml(markdown);
    if (incoming !== editor.getHTML()) {
      editor.commands.setContent(incoming, { emitUpdate: false });
    }
  }, [markdown, editor]);

  const flash = useCallback((label: string) => {
    setCopied(label);
    setTimeout(() => setCopied(null), 1600);
  }, []);

  const copyFormatted = useCallback(async () => {
    if (!editor) return;
    const html = editor.getHTML();
    await copyRich(html, htmlToMarkdown(html));
    flash('formatted');
  }, [editor, flash]);

  const copyPlain = useCallback(
    async (kind: 'markdown' | 'html') => {
      if (!editor) return;
      const html = editor.getHTML();
      await navigator.clipboard.writeText(
        kind === 'markdown' ? htmlToMarkdown(html) : html,
      );
      flash(kind);
    },
    [editor, flash],
  );

  if (!editor) {
    return <div className="min-h-[24rem] animate-pulse rounded-md border bg-muted/30" />;
  }

  const html = editor.getHTML();

  return (
    <div className="space-y-3">
      <Toolbar editor={editor} />

      {showSource ? (
        <pre className="max-h-[24rem] overflow-auto rounded-md border bg-muted/40 p-4 text-xs">
          {htmlToMarkdown(html)}
        </pre>
      ) : (
        <EditorContent editor={editor} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={copyFormatted}>
          {copied === 'formatted' ? 'Copied' : 'Copy formatted'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => copyPlain('markdown')}>
          {copied === 'markdown' ? 'Copied' : 'Copy markdown'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => copyPlain('html')}>
          {copied === 'html' ? 'Copied' : 'Copy HTML'}
        </Button>

        <Separator orientation="vertical" className="h-6" />

        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            download(`${filenameBase}.md`, htmlToMarkdown(html), 'text/markdown')
          }
        >
          Download .md
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            download(
              `${filenameBase}.html`,
              toStandaloneHtml(filenameBase, html),
              'text/html',
            )
          }
        >
          Download .html
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            // .doc, not .docx. See toWordHtml: Word opens HTML under this
            // extension with real heading styles, and writing a true .docx
            // would mean shipping a zip library for no extra fidelity.
            download(
              `${filenameBase}.doc`,
              toWordHtml(filenameBase, html),
              'application/msword',
            )
          }
        >
          Download .doc
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => setShowSource((current) => !current)}
        >
          {showSource ? 'Edit' : 'View source'}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        <span className="font-medium">Copy formatted</span> puts HTML on the
        clipboard, so headings, bold and links survive a paste into Shopify,
        WordPress or Google Docs. In Shopify, paste into the rich text box on
        the blog post, not the HTML view. The markdown button is for anywhere
        that wants plain text, and <span className="font-medium">.doc</span>{' '}
        opens in Word or Google Docs with the headings intact.
      </p>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const setLink = useCallback(() => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', previous ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border p-1">
      {([1, 2, 3] as const).map((level) => (
        <ToolButton
          key={level}
          active={editor.isActive('heading', { level })}
          onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
        >
          H{level}
        </ToolButton>
      ))}
      <ToolButton
        active={editor.isActive('paragraph')}
        onClick={() => editor.chain().focus().setParagraph().run()}
      >
        P
      </ToolButton>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <ToolButton
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <strong>B</strong>
      </ToolButton>
      <ToolButton
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <em>I</em>
      </ToolButton>
      <ToolButton
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <s>S</s>
      </ToolButton>
      <ToolButton active={editor.isActive('link')} onClick={setLink}>
        Link
      </ToolButton>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <ToolButton
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        List
      </ToolButton>
      <ToolButton
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1.
      </ToolButton>
      <ToolButton
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        Quote
      </ToolButton>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <ToolButton
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      >
        Undo
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
      >
        Redo
      </ToolButton>
      <ToolButton
        onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
      >
        Clear
      </ToolButton>
    </div>
  );
}

function ToolButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-7 min-w-7 rounded px-2 text-xs transition-colors',
        'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40',
        active && 'bg-foreground text-background hover:bg-foreground',
      )}
    >
      {children}
    </button>
  );
}
