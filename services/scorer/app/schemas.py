"""Wire format shared with the NestJS gateway.

Keep these in sync with apps/api/src/scorer/scorer.types.ts.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Verdict = Literal["human", "mixed", "ai"]


class ScoreRequest(BaseModel):
    text: str = Field(min_length=1)
    # Skips the per-sentence breakdown. The humanize loop calls the service
    # many times per request and only needs the document number on most passes.
    sentences: bool = True


class SimilarityRequest(BaseModel):
    original: str = Field(min_length=1)
    rewritten: str = Field(min_length=1)


class SimilarityResponse(BaseModel):
    """Rarity-weighted lexical overlap between two texts.

    A SCREEN, not a verdict. It reliably catches a rewrite that is about a
    different subject. It cannot tell a good paraphrase from a meaning
    reversal, because reversal keeps the vocabulary. The gateway treats it
    accordingly and gates on it only at a low floor.
    """

    cosine: float
    anchor_retention: float
    anchors_lost: list[str]
    weighted: bool


class SentenceScore(BaseModel):
    index: int
    text: str
    start: int
    end: int
    words: int
    # exp(mean token NLL) for this sentence. Low means predictable.
    perplexity: float
    # 0-100. Only meaningful for sentences at or above the minimum length.
    ai_score: float
    scored: bool


class Metrics(BaseModel):
    """The raw feature vector, exposed so the UI can explain the number."""

    perplexity: float
    log_perplexity: float
    burstiness: float
    sentence_length_cv: float
    mean_sentence_words: float
    type_token_ratio: float
    repeated_trigram_rate: float
    tell_word_rate: float
    em_dash_rate: float
    punctuation_variety: float
    paragraph_length_cv: float
    mean_word_length: float


class ReadabilityCheck(BaseModel):
    id: str
    label: str
    value: float
    target: str
    status: Literal["good", "warn", "bad"]
    detail: str
    # Example sentences that fail this check, for the humanize loop to target.
    offenders: list[str] = Field(default_factory=list)


class Readability(BaseModel):
    """Yoast-style SEO readability. A different axis from detection scoring."""

    word_count: int
    sentence_count: int
    checks: list[ReadabilityCheck]


class ScoreResponse(BaseModel):
    ai_score: float = Field(ge=0, le=100)
    verdict: Verdict
    # How far the score sits from the undecided band. Not a probability.
    confidence: float
    metrics: Metrics
    sentences: list[SentenceScore]
    word_count: int
    backend: str
    model: str
    calibrated: bool
    # The score projected onto a commercial detector's scale. Use this when
    # comparing against what a user sees on ZeroGPT; `ai_score` is the raw
    # internal number and is on a different, much narrower scale.
    estimated_external: float
    estimated_external_target: str
    estimated_external_confidence: str
    readability: Readability
    elapsed_ms: float
