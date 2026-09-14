"""Does the rewrite still mean what the original meant?

This lives here rather than in the gateway because the answer needs word
frequency data, and this service already loads it.

The naive check is content-word overlap, and it is actively wrong for this
product. A good paraphrase replaces most of its content words on purpose:
"a pivotal technology in the modern business landscape" becoming "sits at the
center of how businesses operate" preserves the meaning exactly while sharing
almost nothing lexically. Overlap scores that rewrite at roughly 30% and
rejects it, which penalises the pipeline for working.

What survives a good paraphrase is the *topical* vocabulary. Style words get
swapped freely; the words carrying the subject matter do not. "machine
learning", "revenue" and "finance" stay put while "pivotal", "comprehensive"
and "multifaceted" are exactly what the humanizer is supposed to remove.

So words are weighted by rarity before comparison. Rare words dominate the
score, common ones barely register, and dropping a tell word costs almost
nothing. This is TF-IDF cosine with corpus frequencies standing in for IDF.

It remains a lexical measure. It cannot catch a fluent rewrite that reverses a
claim while keeping the topical nouns. Sentence embeddings would, and the
endpoint shape here is deliberately the one an embedding backend would use, so
swapping the internals later does not change the caller.
"""

from __future__ import annotations

import math
from collections import Counter

from .features import TELL_PHRASES, TELL_WORDS
from .segment import word_tokens

# Function words carry no topical signal and would otherwise dominate the
# vectors purely by frequency.
STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "if", "then", "than", "as", "of",
    "at", "by", "for", "with", "about", "into", "to", "from", "in", "on",
    "off", "over", "under", "is", "are", "was", "were", "be", "been", "being",
    "am", "do", "does", "did", "have", "has", "had", "will", "would", "shall",
    "should", "can", "could", "may", "might", "must", "it", "its", "this",
    "that", "these", "those", "i", "you", "he", "she", "we", "they", "them",
    "their", "his", "her", "our", "your", "my", "me", "him", "us", "not",
    "no", "so", "up", "out", "there", "here", "what", "which", "who", "whom",
    "when", "where", "why", "how", "all", "any", "both", "each", "more",
    "most", "other", "some", "such", "only", "own", "same", "very", "just",
    "also", "too", "s", "t", "don", "now", "one", "two",
}

# Surprisal bounds, in nats. The floor keeps a very common word from being
# weighted to nothing; the ceiling stops a single typo or proper noun from
# swamping the vector on its own.
MIN_WEIGHT = 2.0
MAX_WEIGHT = 13.0

try:  # pragma: no cover - depends on install extras
    from wordfreq import word_frequency as _word_frequency
except ImportError:  # pragma: no cover
    _word_frequency = None


def _light_stem(word: str) -> str:
    """Just enough to treat plurals and simple inflections as one word.

    Deliberately conservative. An aggressive stemmer would start collapsing
    genuinely different words and let real meaning drift through the check.
    """
    for suffix, replacement in (
        ("ies", "y"),
        ("sses", "ss"),
        ("shes", "sh"),
        ("ches", "ch"),
        ("ing", ""),
        ("ed", ""),
        ("s", ""),
    ):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: len(word) - len(suffix)] + replacement
    return word


def rarity(word: str) -> float:
    """Weight for one word: its surprisal under English unigram frequencies."""
    if _word_frequency is None:
        # Without frequency data, length is a crude proxy for rarity. Monotone
        # and better than treating every word as equally important.
        return max(MIN_WEIGHT, min(MAX_WEIGHT, 1.5 + 0.9 * len(word)))
    probability = _word_frequency(word, "en")
    if probability <= 0:
        return MAX_WEIGHT
    return max(MIN_WEIGHT, min(MAX_WEIGHT, -math.log(probability)))


def _weighted_vector(text: str) -> tuple[dict[str, float], dict[str, str]]:
    """Rarity-weighted bag of stems, plus a stem to surface-form map."""
    vector: dict[str, float] = {}
    surface: dict[str, str] = {}
    counts = Counter(
        token for token in word_tokens(text)
        if len(token) > 2 and token not in STOPWORDS
    )
    for token, count in counts.items():
        stem = _light_stem(token)
        vector[stem] = vector.get(stem, 0.0) + count * rarity(token)
        surface.setdefault(stem, token)
    return vector, surface


def _cosine(left: dict[str, float], right: dict[str, float]) -> float:
    if not left or not right:
        return 0.0
    shared = set(left) & set(right)
    dot = sum(left[key] * right[key] for key in shared)
    left_norm = math.sqrt(sum(value * value for value in left.values()))
    right_norm = math.sqrt(sum(value * value for value in right.values()))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def compare(original: str, rewritten: str) -> dict[str, object]:
    """Compare two texts and report how much topical meaning survived."""
    source, source_surface = _weighted_vector(original)
    target, _ = _weighted_vector(rewritten)

    cosine = _cosine(source, target)

    # Anchors are the heaviest words in the original: its subject matter.
    # Losing one of these is what meaning drift actually looks like, and it is
    # far more diagnostic than any aggregate number.
    anchors = sorted(source.items(), key=lambda item: item[1], reverse=True)
    anchor_count = max(3, min(15, len(anchors) // 3))
    top_anchors = anchors[:anchor_count]

    lost = [
        source_surface[stem]
        for stem, _ in top_anchors
        # A tell word the humanizer was told to remove is not a lost anchor.
        # Counting it as one would penalise the pipeline for doing its job.
        if stem not in target
        and source_surface[stem] not in TELL_WORDS
        and not any(source_surface[stem] in phrase for phrase in TELL_PHRASES)
    ]

    kept = anchor_count - len(lost)
    anchor_retention = kept / anchor_count if anchor_count else 1.0

    return {
        "cosine": round(cosine, 4),
        "anchor_retention": round(anchor_retention, 4),
        "anchors_lost": lost[:8],
        "weighted": _word_frequency is not None,
    }
