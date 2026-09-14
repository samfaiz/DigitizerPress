"""Turn a feature vector into a calibrated 0-100 score.

The model is plain logistic regression. That is a deliberate choice: every
term is inspectable, the UI can explain which feature drove the number, and
refitting on a new corpus is a twenty-line script rather than a training run.

The weights below are PRIORS, not fitted values. Their centers were measured
against sample text on each backend and their directions come from the
published literature, so they rank documents sensibly out of the box. They
will NOT give you a trustworthy absolute percentage. Run scripts/train.py
against a labelled corpus before showing a number to a user as fact.
"""

from __future__ import annotations

import json
import math
import os
import statistics
import time
from dataclasses import dataclass

from .config import settings
from .features import TELL_PHRASES, TELL_WORDS, surface_features
from .perplexity import Backend, TokenScore, get_backend
from .readability import analyse as analyse_readability
from .schemas import Metrics, Readability, ScoreResponse, SentenceScore
from .segment import Span, split_sentences, word_tokens


@dataclass(frozen=True)
class Term:
    """One logistic term: (value - center) / scale, times weight.

    `log1p` compresses unbounded rate features before centering. Without it a
    tell-word-saturated paragraph produces a z of 40 and the output pins at
    exactly 100, which is both wrong and useless to a user trying to improve.
    """

    center: float
    scale: float
    weight: float
    log1p: bool = False


# No single feature may move the decision by more than this many logits, and
# the total is clamped too. Together these hold the output inside roughly
# 0.3-99.7, so the UI never claims certainty the model does not have.
MAX_TERM_CONTRIBUTION = 3.0
MAX_LOGIT = 6.0
BIAS = 0.0

# Below this many scoreable sentences the variance features are meaningless,
# so they are damped toward neutral rather than reporting a spurious zero
# spread as strong evidence of machine authorship.
MIN_SENTENCES_FOR_VARIANCE = 5

# Perplexity scales are backend specific, so each backend gets its own centers.
# A unigram surprisal of 7.6 nats and a GPT-2 conditional surprisal of 3.5 nats
# mean completely different things.
# CALIBRATION WARNING. The transformer centers were measured, but against a
# handful of documents, not a corpus. That is enough to fix the direction and
# rough magnitude of each term and nothing more. Short conventional prose still
# reads as machine-written to this model, which is the standard detector
# false-positive mode. Run scripts/train.py before treating any number here as
# fact.
PRIORS: dict[str, dict[str, Term]] = {
    "transformer": {
        # Centers below were measured on distilgpt2 against sample documents,
        # not guessed. The first version centered this at 3.55, which happened
        # to be almost exactly the value AI text produces, so machine text
        # contributed nothing to its own detection.
        #
        # Weight reduced from the textbook value because low perplexity is a
        # genuine false-positive trap: conventional factual prose is highly
        # predictable. Measured news copy came in at 3.36, BELOW the 3.54 of
        # obvious machine text. Perplexity cannot carry this alone.
        "log_perplexity": Term(center=3.90, scale=0.45, weight=-0.85),
        # Downweighted hard on evidence. Across measured samples this spanned
        # only 0.54 to 0.79 with machine text sitting mid-range, so at document
        # length on a distilled model it is close to noise. The literature's
        # strong burstiness result assumes a larger model and longer text.
        "burstiness": Term(center=0.60, scale=0.15, weight=-0.45),
        # Promoted to the primary signal. It separated every sample cleanly and
        # in the right order: 0.19 machine, 0.37 news, 1.19 personal writing.
        "sentence_length_cv": Term(center=0.55, scale=0.30, weight=-1.30),
        "repeated_trigram_rate": Term(center=0.04, scale=0.05, weight=0.45),
        "tell_word_rate": Term(center=1.95, scale=1.60, weight=0.85, log1p=True),
        "em_dash_rate": Term(center=1.10, scale=1.20, weight=0.35, log1p=True),
        "punctuation_variety": Term(center=0.42, scale=0.18, weight=-0.30),
        "paragraph_length_cv": Term(center=0.45, scale=0.25, weight=-0.35),
        "type_token_ratio": Term(center=0.72, scale=0.10, weight=-0.20),
        # Measured 6.55 machine against 4.04 personal, 4.85 news.
        "mean_word_length": Term(center=5.00, scale=0.60, weight=0.60),
    },
    "heuristic": {
        # NOTE the sign flip against the transformer backend, which is not a
        # typo. A unigram model has no context, so it does not measure
        # predictability at all: it measures vocabulary rarity. Model prose
        # reaches for formal, low-frequency words, so on this backend HIGH
        # surprisal indicates AI, the opposite of the conditional case.
        # Center measured at 7.2-8.4 nats across sample documents.
        "log_perplexity": Term(center=7.60, scale=0.60, weight=0.55),
        # Sentence-level unigram spread is dominated by whether a sentence
        # happens to contain a rare proper noun, so it is close to noise here.
        # Kept for continuity with the transformer backend at a low weight.
        "burstiness": Term(center=0.90, scale=0.35, weight=-0.35),
        # With no conditional signal the surface features carry the decision.
        "sentence_length_cv": Term(center=0.55, scale=0.22, weight=-1.00),
        "repeated_trigram_rate": Term(center=0.04, scale=0.05, weight=0.60),
        "tell_word_rate": Term(center=1.95, scale=1.60, weight=1.30, log1p=True),
        "em_dash_rate": Term(center=1.10, scale=1.20, weight=0.50, log1p=True),
        "punctuation_variety": Term(center=0.42, scale=0.18, weight=-0.40),
        "paragraph_length_cv": Term(center=0.45, scale=0.25, weight=-0.50),
        "type_token_ratio": Term(center=0.72, scale=0.10, weight=-0.25),
        "mean_word_length": Term(center=4.70, scale=0.55, weight=0.65),
    },
}


def _logistic(z: float) -> float:
    if z < -60:
        return 0.0
    if z > 60:
        return 1.0
    return 1.0 / (1.0 + math.exp(-z))


def _clamp(value: float, limit: float) -> float:
    return max(-limit, min(limit, value))


def load_weights() -> tuple[dict[str, Term], float, bool]:
    """Load fitted weights if scripts/train.py has produced any, else priors."""
    path = settings.weights_path
    fallback = PRIORS.get(settings.backend, PRIORS["heuristic"])

    if not path or not os.path.exists(path):
        return fallback, BIAS, False

    try:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
        block = payload.get(settings.backend)
        if not block:
            return fallback, BIAS, False
        terms = {
            name: Term(
                float(spec["center"]),
                float(spec["scale"]),
                float(spec["weight"]),
                bool(spec.get("log1p", False)),
            )
            for name, spec in block["terms"].items()
        }
        return terms, float(block.get("bias", BIAS)), True
    except (OSError, KeyError, ValueError, TypeError):
        # A malformed weights file must never take the service down.
        return fallback, BIAS, False


def fold_tokens_into_sentences(
    tokens: list[TokenScore], sentences: list[Span]
) -> list[list[float]]:
    """Assign each token's surprisal to the sentence containing its start char.

    Tokens and sentences are both in document order, so this is a single linear
    walk rather than a nested scan.
    """
    buckets: list[list[float]] = [[] for _ in sentences]
    if not sentences:
        return buckets

    cursor = 0
    for token in tokens:
        while cursor < len(sentences) - 1 and token.start >= sentences[cursor].end:
            cursor += 1
        current = sentences[cursor]
        if current.start <= token.start < current.end:
            buckets[cursor].append(token.nll)
    return buckets


def _tell_word_pressure(text: str) -> float:
    """Logit contribution from model-favoured vocabulary in one sentence."""
    tokens = word_tokens(text)
    if not tokens:
        return 0.0
    lowered = text.lower()
    hits = sum(1 for token in tokens if token in TELL_WORDS)
    hits += sum(lowered.count(phrase) * 2 for phrase in TELL_PHRASES)
    if not hits:
        return 0.0
    return min(2.0, 0.9 * math.log1p(1000.0 * hits / len(tokens) / 20.0))


def _sentence_ai_score(
    log_perplexity: float,
    text: str,
    direction: float,
    doc_logit: float,
    doc_mean: float,
    doc_spread: float,
) -> float:
    """Score one sentence for the heat map.

    This is a WITHIN-DOCUMENT comparison, not an absolute threshold, for two
    reasons. One sentence carries far too little evidence to support the full
    feature vector. And the absolute perplexity scale differs per backend and
    per topic, so a fixed cutoff mislabels entire genres. Comparing a sentence
    against its own document is scale free and self-calibrating.

    The score is anchored on the document verdict so a document that reads as
    machine-written does not show half its sentences in human colours purely
    because they sit below its own mean.
    """
    z = 0.55 * doc_logit
    z += 0.9 * direction * (log_perplexity - doc_mean) / doc_spread
    z += _tell_word_pressure(text)
    return round(100.0 * _logistic(_clamp(z, 4.0)), 1)


def score_text(text: str, with_sentences: bool = True) -> ScoreResponse:
    started = time.perf_counter()
    backend: Backend = get_backend()
    terms, bias, calibrated = load_weights()

    sentences = split_sentences(text)
    tokens = backend.score_tokens(text)
    buckets = fold_tokens_into_sentences(tokens, sentences)

    all_nll = [token.nll for token in tokens]
    mean_nll = statistics.fmean(all_nll) if all_nll else 0.0

    # Pass one: per-sentence mean surprisal, kept in log space so that
    # burstiness is a scale-stable spread rather than a raw perplexity range.
    sentence_log_ppl: list[float] = []
    long_enough: list[bool] = []
    for index, span in enumerate(sentences):
        values = buckets[index]
        sentence_log_ppl.append(statistics.fmean(values) if values else mean_nll)
        long_enough.append(span.word_count >= settings.min_sentence_words)

    scoreable = [
        value for value, ok in zip(sentence_log_ppl, long_enough) if ok
    ]
    enough_sentences = len(scoreable) >= MIN_SENTENCES_FOR_VARIANCE
    burstiness = statistics.pstdev(scoreable) if len(scoreable) > 1 else 0.0

    values: dict[str, float] = {
        "log_perplexity": mean_nll,
        "burstiness": burstiness,
        **surface_features(text, sentences),
    }

    z = bias
    for name, term in terms.items():
        if name not in values:
            continue
        raw = values[name]
        if term.log1p:
            raw = math.log1p(max(0.0, raw))
        contribution = term.weight * (raw - term.center) / term.scale
        # Damp rather than drop the variance features on short input, so a
        # three-sentence paste degrades gracefully instead of lying.
        if not enough_sentences and name in {
            "burstiness",
            "sentence_length_cv",
            "paragraph_length_cv",
        }:
            contribution *= 0.25
        z += _clamp(contribution, MAX_TERM_CONTRIBUTION)

    z = _clamp(z, MAX_LOGIT)
    probability = _logistic(z)
    ai_score = round(100.0 * probability, 1)

    # Pass two: the heat map, which needs the document verdict from pass one.
    sentence_rows: list[SentenceScore] = []
    if with_sentences:
        direction = 1.0 if terms["log_perplexity"].weight > 0 else -1.0
        doc_mean = statistics.fmean(scoreable) if scoreable else mean_nll
        doc_spread = max(statistics.pstdev(scoreable) if len(scoreable) > 1 else 0.0, 0.35)

        for index, span in enumerate(sentences):
            log_ppl = sentence_log_ppl[index]
            sentence_rows.append(
                SentenceScore(
                    index=index,
                    text=span.text,
                    start=span.start,
                    end=span.end,
                    words=span.word_count,
                    perplexity=round(math.exp(min(log_ppl, 20.0)), 2),
                    ai_score=_sentence_ai_score(
                        log_ppl, span.text, direction, z, doc_mean, doc_spread
                    )
                    if long_enough[index]
                    # Spans below the word floor inherit the document verdict
                    # instead of inventing one. `scored` tells the UI to render
                    # them neutral.
                    else ai_score,
                    scored=long_enough[index],
                )
            )

    if ai_score >= settings.ai_floor:
        verdict = "ai"
    elif ai_score <= settings.human_ceiling:
        verdict = "human"
    else:
        verdict = "mixed"

    # Distance from the undecided band, damped when the input is too short to
    # support the variance features. Not a probability, and labelled as such.
    midpoint = (settings.ai_floor + settings.human_ceiling) / 2.0
    spread = max(1.0, 100.0 - midpoint)
    confidence = min(1.0, abs(ai_score - midpoint) / spread)
    if not enough_sentences:
        confidence *= 0.5

    return ScoreResponse(
        ai_score=ai_score,
        verdict=verdict,
        confidence=round(confidence, 3),
        metrics=Metrics(
            perplexity=round(math.exp(min(mean_nll, 20.0)), 2),
            log_perplexity=round(mean_nll, 4),
            burstiness=round(burstiness, 4),
            sentence_length_cv=round(values["sentence_length_cv"], 4),
            mean_sentence_words=round(values["mean_sentence_words"], 2),
            type_token_ratio=round(values["type_token_ratio"], 4),
            repeated_trigram_rate=round(values["repeated_trigram_rate"], 4),
            tell_word_rate=round(values["tell_word_rate"], 3),
            em_dash_rate=round(values["em_dash_rate"], 3),
            punctuation_variety=round(values["punctuation_variety"], 4),
            paragraph_length_cv=round(values["paragraph_length_cv"], 4),
            mean_word_length=round(values["mean_word_length"], 3),
        ),
        sentences=sentence_rows,
        word_count=len(word_tokens(text)),
        backend=backend.name,
        model=backend.model,
        calibrated=calibrated,
        estimated_external=round(
            max(
                0.0,
                min(
                    100.0,
                    settings.calibration_slope * ai_score
                    + settings.calibration_intercept,
                ),
            ),
            1,
        ),
        estimated_external_target=settings.calibration_target,
        estimated_external_confidence=(
            f"linear fit on {settings.calibration_points} hand-measured articles; "
            "corrects the scale, not the model"
        ),
        # Computed on every score call. It is pure text statistics and costs
        # well under a millisecond, so a separate round trip would be waste.
        readability=Readability(**analyse_readability(text)),
        elapsed_ms=round((time.perf_counter() - started) * 1000, 2),
    )
