"""Behavioural tests for the scorer.

These assert relative ordering and structural invariants, never exact scores.
The exact numbers are expected to move whenever the weights are refit, and a
test that pins them would just have to be rewritten each time.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.scoring import score_text  # noqa: E402
from app.segment import split_sentences  # noqa: E402

MACHINE = (
    "Artificial intelligence has become a pivotal technology in the modern "
    "business landscape. It is important to note that AI plays a crucial role "
    "in driving operational efficiency across multiple sectors. Moreover, "
    "organizations increasingly leverage robust machine learning frameworks to "
    "facilitate data-driven decision making. Furthermore, this comprehensive "
    "approach underscores the multifaceted nature of digital transformation. "
    "In conclusion, companies that embark on this journey will unlock value."
)

HUMAN = (
    "I got the bus at seven every morning for two years. Rain, mostly. The "
    "driver knew me by then, or at least he nodded, which where I grew up "
    "counts as knowing someone. We never exchanged names. Then one Tuesday he "
    "wasn't there and a woman with a lanyard was driving instead and I "
    "remember being thrown by it, more than made sense, and I sat near the "
    "back the whole way in. He came back the next week. I didn't ask."
)


def test_machine_text_outranks_human_text():
    assert score_text(MACHINE).ai_score > score_text(HUMAN).ai_score


def test_score_never_saturates():
    # A pinned 0 or 100 tells the user the model is certain. It is not.
    for text in (MACHINE, HUMAN):
        result = score_text(text)
        assert 0.0 < result.ai_score < 100.0


def test_sentence_offsets_index_back_into_the_source():
    result = score_text(HUMAN)
    for sentence in result.sentences:
        assert HUMAN[sentence.start:sentence.end] == sentence.text


def test_sentences_cover_every_segment():
    result = score_text(MACHINE)
    assert len(result.sentences) == len(split_sentences(MACHINE))


def test_short_input_reports_low_confidence():
    # Two sentences cannot support the variance features, and the response
    # has to say so rather than projecting false certainty.
    result = score_text("This is one sentence. Here is a second one to pair it.")
    assert result.confidence <= 0.5


def test_sentences_can_be_skipped_for_the_humanize_loop():
    result = score_text(MACHINE, with_sentences=False)
    assert result.sentences == []
    assert result.ai_score > 0


def test_empty_ish_input_does_not_crash():
    result = score_text("Hello.")
    assert 0.0 <= result.ai_score <= 100.0
    assert result.word_count == 1
