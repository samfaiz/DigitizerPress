# Gateway

NestJS. Owns the humanize loop, the provider abstraction and every limit.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /api/config` | limits, style profiles, and live health of both backing services |
| `POST /api/score` | score only, no LLM |
| `POST /api/humanize` | the full loop |

Both POST routes are rate limited and cached by content hash.

## Layout

```
config/        env parsing, one global module
scorer/        HTTP client for the Python service
llm/           provider interface plus ollama, groq, gemini, echo
humanize/      the loop
  pipeline/
    mask.ts           protect spans a paraphrase would corrupt
    chunk.ts          split into rewrite units on paragraph boundaries
    prompts.ts        style profiles
    deterministic.ts  the free, model-free half of the humanizer
    fidelity.ts       three-layer guard: constraints, topical screen, judge
    text.ts           shared segmentation and normalisation
common/        rate limiting, result cache
```

## The two rules that hold the design together

**The detector is behind one narrow interface.** `ScorerService` is the only
path to it, and scoring is the only thing it is used for. That is what stops
the humanizer from quietly training against its own grader.

**Winning is not the same as scoring well.** A candidate is kept only if it
lowers the score *and* clears all three fidelity layers. Without that second
condition the loop discovers that the cheapest way to beat a detector is to
stop saying what the source said.

Note what the layers are NOT allowed to be: lexical overlap. That was the first
implementation and it rejected every good rewrite, because paraphrasing means
replacing words. See the root README for the measurements.

## Tests

```bash
npm test
```

Covers masking, the deterministic rules, chunking and fidelity. Notable cases:
bare small integers stay unmasked so the text remains rewritable, quotations of
four words or more are frozen while short scare quotes are not, and restoring a
placeholder must not eat the whitespace after it.
