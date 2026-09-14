# Scorer

Independent AI-text detection scoring. FastAPI, stateless, private.

The NestJS gateway is the only client. This service is never exposed to the
browser, and it owns no rate limiting, caching or word caps of its own.

## Run

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv fastapi "uvicorn[standard]" pydantic numpy wordfreq
.venv/bin/python -m uvicorn app.main:app --reload --port 8000
```

## Backends

| Backend | Needs | What it measures |
| --- | --- | --- |
| `transformer` (default) | torch, transformers, one model download | true conditional surprisal |
| `heuristic` | nothing beyond the base install | vocabulary rarity, via unigram frequencies |

```bash
uv pip install --python .venv torch transformers
SCORER_BACKEND=transformer .venv/bin/python -m uvicorn app.main:app --port 8000
```

The heuristic backend exists so the pipeline runs from a cold clone. It has no
context, so it cannot measure predictability at all. Its perplexity term
therefore carries the **opposite sign** to the transformer backend: formal,
low-frequency vocabulary indicates machine authorship there, where low
conditional surprisal indicates it in the real case. That sign flip is
intentional and commented in `app/scoring.py`.

## Endpoints

`GET /health` reports the active backend, the model and whether fitted weights
are loaded.

`POST /score` takes `{ text, sentences }` and returns the document score, the
verdict, the confidence, the full feature vector and the per-sentence
breakdown with character offsets. Set `sentences: false` to skip the breakdown;
the humanize loop calls this several times per request and only needs the
document number on most passes.

## Files

```
app/config.py      env-driven settings
app/segment.py     sentence and paragraph splitting with exact offsets
app/features.py    the model-free half of the feature vector
app/perplexity.py  both backends behind one interface
app/scoring.py     feature vector to calibrated 0-100
app/main.py        FastAPI surface
scripts/train.py   refit the weights from a labelled corpus
```

Offsets matter. The perplexity pass maps model tokens onto sentences by
character span, and the frontend highlights by those same spans. A segmenter
that lost offsets would force a slow second forward pass per sentence.

## Calibration

The shipped weights are priors. See the root README for how to fit real ones,
and why you should before showing a percentage to anyone as fact.
