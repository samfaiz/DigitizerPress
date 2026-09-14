"""Sentence and paragraph segmentation with character offsets.

Offsets matter: the perplexity pass maps model tokens back onto sentences by
character span, and the frontend highlights by the same spans. A segmenter that
loses offsets would force a second, slower per-sentence forward pass.

Deliberately dependency free. NLTK or spaCy would segment better on edge cases
but neither is worth a 500MB install for a boundary problem this shallow.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Tokens that end in a period but almost never end a sentence.
_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "rev", "hon",
    "inc", "ltd", "co", "corp", "dept", "est", "fig", "eq", "vol", "no",
    "e.g", "i.e", "etc", "vs", "al", "cf", "approx", "min", "max", "ca",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
    "nov", "dec", "u.s", "u.k", "ph.d", "m.d", "b.a", "m.a",
}

_SENTENCE_END = re.compile(r"[.!?][\"'”’\)\]]*(?=\s|$)")
_WORD = re.compile(r"[A-Za-zÀ-ɏ']+")
_TRAILING_TOKEN = re.compile(r"([A-Za-z\.]+)\.$")


@dataclass(frozen=True)
class Span:
    text: str
    start: int
    end: int

    @property
    def words(self) -> list[str]:
        return _WORD.findall(self.text)

    @property
    def word_count(self) -> int:
        return len(self.words)


def _is_abbreviation(text: str, end: int) -> bool:
    """True when the period at `end` closes a known abbreviation or initial."""
    match = _TRAILING_TOKEN.search(text[:end + 1])
    if not match:
        return False
    token = match.group(1).lower().rstrip(".")
    if token in _ABBREVIATIONS:
        return True
    # Single letter followed by a period is an initial, as in "J. Smith".
    return len(token) == 1 and token.isalpha()


def split_sentences(text: str) -> list[Span]:
    """Split into sentences, preserving exact character offsets into `text`."""
    spans: list[Span] = []
    cursor = 0

    for match in _SENTENCE_END.finditer(text):
        end = match.end()
        if _is_abbreviation(text, match.start()):
            continue
        chunk = text[cursor:end]
        if chunk.strip():
            leading = len(chunk) - len(chunk.lstrip())
            spans.append(Span(chunk.strip(), cursor + leading, end))
        cursor = end

    # Whatever trails the last terminator is still a sentence for our purposes.
    tail = text[cursor:]
    if tail.strip():
        leading = len(tail) - len(tail.lstrip())
        spans.append(Span(tail.strip(), cursor + leading, len(text)))

    return spans


def split_paragraphs(text: str) -> list[Span]:
    """Split on blank lines, preserving offsets."""
    spans: list[Span] = []
    for match in re.finditer(r"[^\n]+(?:\n(?!\s*\n)[^\n]+)*", text):
        chunk = match.group(0)
        if chunk.strip():
            spans.append(Span(chunk.strip(), match.start(), match.end()))
    return spans


def word_tokens(text: str) -> list[str]:
    return _WORD.findall(text.lower())
