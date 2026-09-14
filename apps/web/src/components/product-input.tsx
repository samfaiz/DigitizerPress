'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Product } from '@/lib/types';

interface ProductInputProps {
  value: Product[];
  onChange: (value: Product[]) => void;
  max?: number;
}

/**
 * Products to feature in the article.
 *
 * Three fields per row rather than one, because they do different jobs. The
 * name is what gets mentioned, the URL is what gets linked, and the note is
 * the factual boundary for that product: with the strict facts guard on, the
 * writer may not claim anything about it that is not in the note. Leave the
 * note empty and the article will name the product without describing it,
 * which is the correct behaviour rather than a gap.
 */
export function ProductInput({ value, onChange, max = 12 }: ProductInputProps) {
  const update = (index: number, patch: Partial<Product>) => {
    const next = [...value];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {value.map((product, index) => (
        <div key={index} className="space-y-1.5 rounded-md border p-2">
          <div className="flex gap-2">
            <Input
              value={product.name}
              onChange={(event) => update(index, { name: event.target.value })}
              placeholder="Product name"
              className="flex-1"
            />
            <Input
              value={product.url ?? ''}
              onChange={(event) => update(index, { url: event.target.value })}
              placeholder="https://... (optional)"
              className="flex-1"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
          <Input
            value={product.note ?? ''}
            onChange={(event) => update(index, { note: event.target.value })}
            placeholder="What may be said about it. Left blank, nothing specific will be claimed."
            className="text-xs"
          />
        </div>
      ))}

      {value.length < max && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...value, { name: '', url: '', note: '' }])}
        >
          Add product
        </Button>
      )}

      {value.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Each product is linked by name the first time it appears. No price,
          size or ingredient will be invented: only what you put in the note.
        </p>
      )}
    </div>
  );
}
