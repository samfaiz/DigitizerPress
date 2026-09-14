"""Surface features that separate machine text from human text.

None of these need a model. They are cheap, they are stable across languages
with Latin script, and together they carry a surprising amount of the signal.
Perplexity and burstiness are computed elsewhere and merged in by the scorer.
"""

from __future__ import annotations

import math
import statistics
from collections import Counter

from .segment import Span, split_paragraphs, split_sentences, word_tokens

# Words and phrases that current instruction-tuned models reach for far more
# often than people do. Rate per 1000 words, not raw count, so length neutral.
TELL_WORDS = {
    "delve", "delves", "delving", "underscore", "underscores", "underscoring",
    "tapestry", "realm", "realms", "myriad", "pivotal", "crucial", "vital",
    "moreover", "furthermore", "additionally", "notably", "consequently",
    "nevertheless", "nonetheless", "thereby", "hence", "utilize", "utilizing",
    "leverage", "leveraging", "facilitate", "robust", "seamless", "seamlessly",
    "holistic", "nuanced", "intricate", "multifaceted", "comprehensive",
    "landscape", "navigate", "navigating", "foster", "fostering", "embark",
    "testament", "paramount", "cornerstone", "profound", "unwavering",
    "meticulous", "meticulously", "elevate", "elevating", "harness",
    "showcasing", "encompass", "encompasses", "beacon", "unlock", "unlocking",
}

TELL_PHRASES = (
    "it is important to note",
    "it's important to note",
    "it is worth noting",
    "in conclusion",
    "in today's fast-paced",
    "in the ever-evolving",
    "plays a crucial role",
    "plays a vital role",
    "a testament to",
    "when it comes to",
    "not only that",
    "on the other hand",
    "at the end of the day",
    "dive into",
    "let's explore",
    "in summary",
    "overall,",
)

_PUNCTUATION = "—–;:()[]\"'“”‘’…!?,"


def _cv(values: list[float]) -> float:
    """Coefficient of variation. Length-normalised spread, so it compares
    across documents of different scale in a way stdev alone would not."""
    usable = [v for v in values if v > 0]
    if len(usable) < 2:
        return 0.0
    mean = statistics.fmean(usable)
    if mean == 0:
        return 0.0
    return statistics.pstdev(usable) / mean


def moving_average_ttr(tokens: list[str], window: int = 50) -> float:
    """Type-token ratio over a sliding window.

    Plain TTR falls as documents get longer, which would make length a
    confound. The moving average version does not, so it is comparable
    between a 100-word paste and a 2000-word essay.
    """
    if len(tokens) < window:
        return len(set(tokens)) / len(tokens) if tokens else 0.0
    ratios = [
        len(set(tokens[i:i + window])) / window
        for i in range(len(tokens) - window + 1)
    ]
    return statistics.fmean(ratios)


def repeated_trigram_rate(tokens: list[str]) -> float:
    """Share of word trigrams that appear more than once.

    Models loop on their own phrasing more than writers do, especially in
    long-form output where they restate the thesis every few paragraphs.
    """
    if len(tokens) < 4:
        return 0.0
    trigrams = [tuple(tokens[i:i + 3]) for i in range(len(tokens) - 2)]
    counts = Counter(trigrams)
    repeated = sum(count for count in counts.values() if count > 1)
    return repeated / len(trigrams)


def tell_word_rate(text: str, tokens: list[str]) -> float:
    """Occurrences of model-favoured vocabulary per 1000 words."""
    if not tokens:
        return 0.0
    lowered = text.lower()
    hits = sum(1 for token in tokens if token in TELL_WORDS)
    hits += sum(lowered.count(phrase) * 2 for phrase in TELL_PHRASES)
    return 1000.0 * hits / len(tokens)


def punctuation_variety(text: str) -> float:
    """Shannon entropy over the punctuation profile, normalised to 0-1.

    Human writing uses an uneven, idiosyncratic mix. Model output tends
    toward a flat, textbook distribution of commas and periods.
    """
    counts = Counter(char for char in text if char in _PUNCTUATION)
    total = sum(counts.values())
    if total < 2:
        return 0.0
    entropy = -sum(
        (count / total) * math.log2(count / total) for count in counts.values()
    )
    # abs() clears the -0.0 that a single-symbol profile produces.
    return abs(entropy) / math.log2(len(_PUNCTUATION))


def surface_features(text: str, sentences: list[Span] | None = None) -> dict[str, float]:
    """Extract the model-free half of the feature vector."""
    sentences = sentences if sentences is not None else split_sentences(text)
    paragraphs = split_paragraphs(text)
    tokens = word_tokens(text)

    sentence_words = [float(span.word_count) for span in sentences]
    paragraph_words = [float(span.word_count) for span in paragraphs]

    em_dashes = text.count("—") + text.count(" - ") + text.count("–")

    return {
        "sentence_length_cv": _cv(sentence_words),
        "mean_sentence_words": statistics.fmean(sentence_words) if sentence_words else 0.0,
        "type_token_ratio": moving_average_ttr(tokens),
        "repeated_trigram_rate": repeated_trigram_rate(tokens),
        "tell_word_rate": tell_word_rate(text, tokens),
        "em_dash_rate": 1000.0 * em_dashes / len(tokens) if tokens else 0.0,
        "punctuation_variety": punctuation_variety(text),
        "paragraph_length_cv": _cv(paragraph_words),
        "mean_word_length": statistics.fmean([len(t) for t in tokens]) if tokens else 0.0,
    }
