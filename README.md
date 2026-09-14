# Digitizer Press

Score text for machine-written signals, then rewrite it while holding the
meaning fixed.

Three services. The detector is deliberately separate from the rewriter, so
the score is never grading its own work.

```
apps/web        Next.js 16, Tailwind v4, shadcn UI      :3000
apps/api        NestJS 12 gateway, the humanize loop     :4000
services/scorer FastAPI detector, perplexity + features  :8000
```

## Quickstart

Three terminals. No API keys and no model downloads are required for the
first run: the scorer falls back to a word-frequency backend and the rewriter
falls back to a passthrough, so the whole pipeline runs on a clean clone.

```bash
npm install
```

The scorer needs a Python 3.12 virtualenv once, before its first run:

```bash
cd services/scorer && uv venv --python 3.12 .venv && uv pip install --python .venv fastapi "uvicorn[standard]" pydantic numpy wordfreq
```

```bash
npm run dev:scorer
```

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Then open http://localhost:3000.

### Configuration

Copy the template, then edit the copy. Keep `.env.example` in the repo as the
reference; `.gitignore` already excludes `.env`.

```bash
cp .env.example .env
```

One file at the repo root configures all three services. Each loads it from
wherever it is started, walking up the tree to find it. Real environment
variables always win over the file, so a key exported in your shell or
injected by a deployment platform is never overwritten by a stale local copy.
The web app also reads `apps/web/.env.local`, which takes precedence for
local overrides.

Nothing in `.env` is required. Every value has a working default.

## What actually happens on a request

1. **Normalise.** Strip zero-width characters, normalise Unicode, collapse
   whitespace. Some generators embed invisible characters, and leaving them in
   would let the detector cheat.
2. **Score the input.** The gateway calls the Python service and gets back a
   document score, a per-sentence heat map and the raw feature vector.
3. **Chunk.** Split on paragraph boundaries at roughly 350 words. Oversized
   paragraphs fall back to sentence boundaries, never mid-sentence.
4. **Mask.** Numbers, currency, percentages, years, citations, URLs, emails,
   quotations and code are swapped for opaque placeholders. This is the step
   that stops the model rounding 47.3% to "roughly half".
5. **Rewrite.** One LLM call per chunk, using the selected style profile.
6. **Restore.** Placeholders are put back. A placeholder that cannot be
   restored counts as a fidelity failure rather than being papered over.
7. **Deterministic pass.** Plain code, no model: strip discourse markers,
   replace overused vocabulary, remove em dashes, apply contractions, and on
   later passes split some over-long sentences.
8. **Rescore, then check fidelity.** A candidate is kept only if it lowered the
   score *and* still says what the original said. See below.
9. **Iterate.** Up to three passes. Each retry names the worst-scoring
   sentences so the model changes them rather than returning a near-copy.

If every candidate fails fidelity, the original text is returned unchanged.
That is the correct outcome, and the response says so.

## External detectors

The local scorer is a proxy. It cannot tell you what GPTZero, Originality.ai
or ZeroGPT will say about your text, and a good score here is not evidence of
a good score there. If you are judged by one of those, the loop has to
optimise against that one directly.

Two settings, split for cost:

| Setting | When it runs | Cost |
| --- | --- | --- |
| `DETECTOR_PRIMARY` | once per rewrite pass, so up to three times | the one that matters |
| `DETECTOR_VERIFY` | exactly twice, on the input and final output | a fixed second opinion |

```bash
DETECTOR_PRIMARY=gptzero
DETECTOR_VERIFY=gptzero,originality,zerogpt
GPTZERO_API_KEY=gz-...
```

Leaving `DETECTOR_PRIMARY=local` while verifying against commercial detectors
is the exact mismatch this exists to remove, so the API warns when you do it
and the UI marks the primary in amber.

### What is verified and what is not

This code was written without keys for any of the three, so none of the
response parsing has been exercised against a successful call. Requests were
confirmed to reach both vendors and be rejected on credentials rather than on
shape:

| Detector | Confirmed | Note |
| --- | --- | --- |
| GPTZero | endpoint, method, `x-api-key` header, body accepted (403 on key only) | best documented, returns per-sentence data |
| Originality.ai | endpoint and `X-OAI-API-KEY` accepted (422 on subscription) | **API access requires an Enterprise subscription** |
| ZeroGPT | endpoint, `ApiKey` header and body accepted (401 on key only) | ships several APIs across several domains; set `ZEROGPT_URL` if the default does not match your plan |

Every parser tries a list of known field paths and throws a specific error
naming what actually came back if none match. That is deliberate. A detector
that silently returns a wrong number is worse than one that fails, because the
loop would optimise against noise. If a real key produces a parse error, the
message names the payload keys, which is usually enough to fix the path list.

### Checking a key works

```bash
curl -X POST localhost:4000/api/detectors/test
```

Sends a short, obviously machine-written sample to every configured detector
and reports the score, the latency, or the exact error. Use it the moment you
add a key: the alternative is discovering a bad key after paying for a full
generation run. A detector that answers 200 with a score near zero on that
sample is misconfigured, not lenient.

### The honest limit

No humaniser reliably defeats every detector. They retrain, and this is an
adversarial game. Optimising against the detector that judges you is the best
available approach and it is still not a guarantee.

## SEO readability

The scorer also runs Yoast-style readability checks and returns them on every
score call. They measure a different axis from detection: how easy the text is
for a person to read.

Most of these pull the SAME way as lowering a detection score. Shorter
sentences raise the long-sentence pass rate and widen sentence-length variance,
which is the strongest detection feature. Plainer words raise Flesch and cut
mean word length, another detection signal.

**One pulls the other way, and it is worth understanding.** Yoast wants at
least 30% of sentences to carry a transition word, and the formal ones are
exactly the machine tells the humanizer strips: moreover, furthermore,
additionally, consequently. Deleting them outright took transition density to
5% against a 30% target on real copy.

The resolution is not to pick a side. Yoast counts conversational connectives
too, so formal markers are now SUBSTITUTED rather than deleted: "Moreover"
becomes "And", "Therefore" becomes "So", "Nevertheless" becomes "Still".
Replacements rotate, because opening four sentences in a row with "And" trades
one failing check for another.

### Readability is part of the objective

The loop minimises detection score PLUS a penalty per failing readability
check, set by `READABILITY_WEIGHT` (default 5). Without that, a first pass
that hit the detection target ended the run with readability still failing and
the feedback prepared for pass two never ran.

Failing checks are also fed back into the retry prompt with example offending
sentences. Telling a model "17% of sentences are passive" gives it nothing to
act on; giving it three passive sentences to fix does.

Measured on a 500-word SEO page, before and after:

| Check | Before | After |
| --- | --- | --- |
| Detection score | 75.8 | 19.0 |
| Flesch Reading Ease | 35.9 | 71.0 |
| Sentences over 20 words | 48% | 7.8% |
| Transition words | 4.0% | 29.4% |
| Passive voice | 8.0% | 5.9% |

Set `READABILITY_WEIGHT=0` to optimise detection only.

## Spend

Every response carries the tokens and dollars that request cost, broken down
by model, and the UI shows it in a Cost tab. Output tokens include thinking
tokens, which are billed but never shown, so the output count exceeds the
visible prose.

Rates are Anthropic first-party and change, so treat the figure as an
estimate. An unrecognised model reports zero rather than guessing.

## Attribution

The delivery contract's structure, its five scoring categories and the 90-point
threshold are adapted from [claude-blog](https://github.com/AgriciDaniel/claude-blog)
by AgriciDaniel, MIT licensed. No code was copied. The gates and every point in
the rubric were rewritten against signals this pipeline can actually measure,
since their visual gate screenshots a rendered page at three viewports and this
is a text API.

## The fidelity guard

The loop optimises a detection score, and the cheapest way to beat a detector
is to stop saying what the source said. This is what stops that.

Three layers run per candidate, cheapest first, short-circuiting on failure.

1. **Hard constraints.** Free and deterministic. Numbers must survive by
   value, protected spans must come back intact, length must stay in bounds.
2. **Topical screen.** One local call for rarity-weighted lexical overlap.
   Catches a rewrite that is simply about something else. Floored low, at 0.1,
   because it is a screen and not a verdict.
3. **Semantic judge.** One small model call that enumerates any claims the
   rewrite dropped, contradicted or invented, then rules on the lists rather
   than on style.

### Why the obvious approach was removed

The first version measured content-word overlap and required 55% retention.
It rejected every rewrite Claude produced, because a good paraphrase replaces
most of its content words on purpose. Real rewrites scored 23% to 44%.

Rarity weighting narrowed the gap but did not close it, and on a controlled
set a meaning-reversed passage scored *higher* than a genuine paraphrase,
because reversal keeps the vocabulary. Worse, the metric was style dependent:
a plain-English rewrite correctly replacing "cardiovascular" with "heart" was
punished for it. No purely lexical measure separates these classes, which is
why layer three exists.

The judge was validated against five controlled cases, and gets all five:
a good paraphrase and a heavy plain-English rewrite pass, while a reversed
claim, a dropped claim and an invented fact are all caught. Forcing it to
enumerate before ruling is what fixed the dropped-claim case; asked only for a
verdict, it noted the omission in its own reasoning and voted "same" anyway.
The parser therefore trusts the enumerated lists over the stated verdict.

An unreadable judge reply becomes `unknown`, which is neither a pass nor a
failure. One malformed reply must not discard a good rewrite, and it must not
wave a bad one through either.

## How the score works

Two backbones, the same ones the commercial detectors are built on.

**Perplexity.** Average negative log-likelihood per token under a causal
language model. Machine text is predictable, so perplexity is low.

**Burstiness.** Standard deviation of per-sentence surprisal. People swing
between short punchy sentences and long rambling ones. Models hold a steady
rhythm. This is the strongest single feature after perplexity itself.

On top of those sit eight surface features: sentence-length variation,
moving-average type-token ratio, repeated trigram rate, tell-word rate,
em-dash rate, punctuation entropy, paragraph-length variation and mean word
length. All of them feed a logistic regression, chosen over anything fancier
because every term stays inspectable and the UI can explain the number.

Per-sentence highlighting is a *within-document* comparison, not an absolute
threshold. One sentence carries too little evidence for the full feature
vector, and absolute perplexity varies by topic and by backend, so a fixed
cutoff would mislabel entire genres.

### What the calibration is worth

The transformer centers were measured, not guessed, and measuring them changed
several of them substantially:

| Feature | First guess | Measured outcome |
| --- | --- | --- |
| Perplexity center | 3.55 | 3.90. The guess sat almost exactly on the value machine text produces, so machine text contributed nothing to its own detection. |
| Burstiness weight | -1.20 | -0.45. It spanned only 0.54 to 0.79 across samples with machine text mid-range. At document length on a distilled model it is close to noise. |
| Sentence-length variation | -0.70 | -1.30. Promoted to primary. It separated every sample cleanly and in the right order. |

Current separation on the sample set:

| Sample | Score | Verdict |
| --- | --- | --- |
| Machine marketing copy | 99.8 | ai |
| Machine listicle | 98.1 | ai |
| Human personal essay | 1.6 | human |
| Human technical note | 0.8 | human |
| Human news report | 40.9 | mixed |
| Human academic abstract | 37.8 | mixed |

Note the last two. Short conventional prose is highly predictable, and measured
news copy had *lower* perplexity than obvious machine text. That is the
standard detector false-positive mode, and it is why the perplexity weight was
cut and the undecided band widened. Those two land in "mixed" rather than being
falsely accused, which is the correct outcome for a genuinely hard case.

**This is still a handful of documents, not a corpus.** It fixes the direction
and rough magnitude of each term and nothing more. **The percentages are not
trustworthy in absolute terms until you fit them.**

To fix that, fit them against a labelled corpus:

```bash
cd services/scorer
uv pip install --python .venv scikit-learn pandas
.venv/bin/python scripts/train.py corpus.csv --out app/weights.json
```

The corpus is a CSV with `text` and `label` columns, where 1 means machine
generated. HC3 and RAID are the usual public starting points. Generate the
machine half with the same models your users actually paste from: a detector
fitted on 2023 output will misjudge 2026 output.

The service picks the file up on restart and flips `calibrated` to true in
both the health check and every score response.

## Choosing the backends

**Scorer.** `transformer` is the default and what you should run. It needs
torch, which is a large install, and it downloads the model on first boot:

```bash
cd services/scorer
uv pip install --python .venv torch transformers
```

`distilgpt2` is the cost and quality sweet spot, and scores a few hundred
words in about 200ms on Apple Silicon. `gpt2` is better and roughly three
times slower. Startup takes around 20 seconds once the model is cached, which
is why the health check does not go green until the first forward pass is done.

`SCORER_BACKEND=heuristic` is the zero-install fallback and approximates
surprisal from word frequency. It has no notion of context, so it measures
vocabulary rarity rather than predictability, and the sign of its perplexity
term is inverted against the real backend for exactly that reason. Use it to
develop the pipeline, never to judge text.

**Rewriter.** `LLM_PROVIDER` takes `anthropic`, `ollama`, `groq`, `gemini`
or `echo`.

- `anthropic` is the production path. Set `ANTHROPIC_API_KEY` and it runs.
  Defaults to `claude-opus-5` at `low` effort.
- `ollama` is free, unlimited and private, and needs no server GPU because it
  runs on your own machine. Install Ollama, then `ollama pull qwen2.5:7b-instruct`.
- `groq` and `gemini` both have free tiers. Verify the current limits and
  whether the tier permits your use before relying on either.
- `echo` returns the input untouched. Every other stage still runs, so the
  deterministic pass and the loop remain fully testable with no setup.

### Anthropic specifics

Three things behave differently from the other providers.

**No sampling controls.** `temperature`, `top_p` and `top_k` were removed on
Opus 5, Sonnet 5 and the 4.6 family, and sending one returns a 400. That
matters here more than in most applications: low-temperature output is exactly
the flat, predictable phrasing the detector scores as machine-written, so
temperature was carrying real weight in this pipeline. That load now sits on
the rhythm instructions in the prompt and on the deterministic pass. Haiku 4.5
still accepts sampling, and the provider sends it only for models that do.

**Thinking is on by default and its tokens count against `max_tokens`.** The
cap is set well above the prose length so a rewrite is never truncated
mid-sentence. A cap is not a spend, so the generous value costs nothing.

**A refusal is not an exception.** It arrives as HTTP 200 with
`stop_reason: "refusal"`, so the provider checks that before reading content.
Server-side fallbacks are enabled by default on Opus 5 and Fable, meaning a
declined request is retried on a fallback model inside the same call rather
than failing the pass. Drop the `fallbacks` parameter in
`anthropic.provider.ts` if you do not want that.

### What $10 buys

Per humanize run on a 1,200-word post: four chunks, roughly 3,800 input tokens
and 2,800 output tokens per pass, at `low` effort. The loop runs up to three
passes and stops early once the target score is met, so the true figure sits
inside this range.

| Model | Per post, 1 pass | Posts per $10, 1 pass | Posts per $10, 3 passes |
| --- | --- | --- | --- |
| `claude-opus-5` | $0.093 | ~107 | ~36 |
| `claude-sonnet-5` | $0.040 | ~250 | ~83 |
| `claude-haiku-4-5` | $0.022 | ~455 | ~152 |

Each figure includes one fidelity judge call per pass, which runs on Haiku by
default and adds roughly 5%. Point `ANTHROPIC_JUDGE_MODEL` at the rewrite
model and that share roughly doubles the bill to answer a yes/no question.

Set the model with `ANTHROPIC_MODEL`. Output tokens are about 80% of the bill,
so `ANTHROPIC_EFFORT` is the effective cost dial short of changing model.

Two things worth knowing before you tune further. Prompt caching will not fire
as written, because the shared system prompt is around 450 tokens and the
minimum cacheable prefix starts at 512. Extending the shared rules past that
threshold would cut input cost, which is the smaller half of the bill. And
these numbers are for *rewriting* text you already have. Generating a post from
scratch has a different shape, small input and large output, and lands in a
similar range per post.

A provider that is selected but not configured falls back to `echo` rather
than throwing on every request, and the response reports which provider
actually ran.

## Tests

```bash
npm test
npm run test:scorer
```

The gateway tests cover masking, the deterministic rules, chunking and the
fidelity guard. The scorer tests assert relative ordering and structural
invariants, never exact scores, because the numbers move whenever the weights
are refit.

## Limits of v1

- **Anonymous only.** No accounts. Rate limiting is by IP, with a burst window
  and an hourly budget, plus a word cap. Those three are the only things
  between the service and a script.
- **Single instance.** The rate limiter and the result cache are in-process by
  default. Set `REDIS_URL` before running two of anything, or each instance
  will enforce its own separate budget.
- **The judge costs a call per pass.** It is the only layer that catches a
  fluent rewrite which reverses a claim, and it adds roughly 5% to the bill.
  Set `FIDELITY_JUDGE=false` to drop it, accepting that layers one and two
  cannot see meaning.
- **English only.** The tell-word lists, the frequency data and the
  segmentation rules all assume English.

## A note on what this is for

Detection scores are estimates, not verdicts. Every detector, including this
one, misfires on short passages, on technical writing and on text by
non-native English writers. The UI says so, and that wording should stay.

The rewriting side has a legitimate use for editing and for writers working in
a second language, and an obvious misuse around coursework. Decide early
whether you gate it behind terms of service. That choice affects your payment
processor more than it affects this architecture.
