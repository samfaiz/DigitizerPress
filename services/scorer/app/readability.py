"""Yoast-style SEO readability analysis.

Separate from detection scoring and measuring a different thing: how easy the
text is for a person to read, not whether a machine wrote it.

Worth understanding how the two interact, because it is not obvious.

Most of these checks pull in the SAME direction as lowering a detection score.
Shorter sentences raise the long-sentence pass rate and also widen sentence
length variance, which is the strongest single detection feature. Plainer words
raise Flesch and also cut mean word length, another detection signal. Improving
readability improves both.

One check pulls the other way. Yoast wants at least 30% of sentences to carry a
transition word, and the formal ones are exactly the machine tells the
humanizer strips: moreover, furthermore, additionally, consequently. The
resolution is not to pick a side. Yoast counts conversational connectives too,
and "but", "so", "because" and "for example" satisfy the check while reading
entirely human. See NATURAL_TRANSITIONS below.

Thresholds are Yoast's published English defaults.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter

from .segment import Span, split_paragraphs, split_sentences, word_tokens

# Yoast English defaults.
MAX_SENTENCE_WORDS = 20
MAX_LONG_SENTENCE_SHARE = 25.0     # percent of sentences over 20 words
MAX_PARAGRAPH_WORDS = 150
MAX_SUBHEADING_GAP_WORDS = 300
MIN_TRANSITION_SHARE = 30.0        # percent of sentences with a transition
MAX_PASSIVE_SHARE = 10.0           # percent of sentences in passive voice
MAX_CONSECUTIVE_SAME_START = 3
MIN_WORD_COUNT = 300
GOOD_FLESCH = 60.0                 # "fairly easy" and above

# Transitions that satisfy Yoast AND read as human. These are what the
# humanizer should substitute in, rather than deleting a formal connective and
# leaving the sentence bare.
NATURAL_TRANSITIONS = {
    "but", "so", "and", "because", "still", "then", "yet", "though",
    "instead", "also", "after", "before", "while", "since", "until",
    "even so", "for example", "for instance", "in fact", "of course",
    "at least", "that said", "either way", "after all", "as a result",
    "on top of that", "which means", "the thing is", "better yet",
}

# Formal transitions Yoast counts but detectors punish. Tracked separately so
# the report can say "your transition density is fine but it is carried by the
# wrong words", which is the actionable version of the finding.
FORMAL_TRANSITIONS = {
    "moreover", "furthermore", "additionally", "consequently", "nevertheless",
    "nonetheless", "notably", "importantly", "thus", "hence", "therefore",
    "subsequently", "accordingly", "in conclusion", "in summary", "overall",
    "ultimately", "in essence", "first and foremost",
}

ALL_TRANSITIONS = NATURAL_TRANSITIONS | FORMAL_TRANSITIONS | {
    "however", "although", "despite", "whereas", "meanwhile", "otherwise",
    "similarly", "likewise", "in contrast", "on the other hand", "in addition",
    "as well as", "rather than", "not only", "in other words", "to sum up",
    "for this reason", "because of this", "in particular", "above all",
}

_BE_FORMS = {"is", "are", "was", "were", "be", "been", "being", "am", "get", "got", "gets"}

# Common irregular past participles. Regular -ed forms are caught by pattern.
_IRREGULAR_PARTICIPLES = {
    "done", "made", "given", "taken", "seen", "known", "shown", "written",
    "found", "held", "kept", "left", "led", "met", "paid", "put", "read",
    "said", "sent", "set", "sold", "told", "brought", "bought", "built",
    "caught", "chosen", "driven", "eaten", "fallen", "felt", "forgotten",
    "gone", "grown", "heard", "hidden", "lost", "meant", "proven", "run",
    "seen", "sought", "spoken", "spent", "stood", "taught", "thought",
    "thrown", "understood", "won", "considered", "based", "used",
}

# Words ending in -ed that are adjectives, not participles. "The compositions
# are sophisticated" is a description, not a passive construction, and flagging
# it inflated the passive rate on real copy.
_ADJECTIVAL_ED = {
    "sophisticated", "interested", "excited", "tired", "complicated",
    "dedicated", "detailed", "limited", "advanced", "experienced", "related",
    "mixed", "involved", "concerned", "talented", "gifted", "aged", "alleged",
    "beloved", "crooked", "learned", "naked", "sacred", "wicked", "wretched",
    "surprised", "pleased", "delighted", "worried", "bored", "confused",
    "embarrassed", "frightened", "satisfied", "unexpected", "supposed",
    "curved", "pointed", "rounded", "elevated", "refined", "understated",
    "balanced", "layered", "textured", "storied", "celebrated",
}

_VOWEL_GROUP = re.compile(r"[aeiouy]+")
_SUBHEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(\S.*)$", re.MULTILINE)


def count_syllables(word: str) -> int:
    """Heuristic syllable count for the Flesch formula.

    Vowel groups, minus a silent trailing e, floored at one. Not perfect, but
    Flesch is a coarse index and the error averages out across a document.
    """
    word = word.lower().strip("'")
    if not word:
        return 0
    groups = _VOWEL_GROUP.findall(word)
    count = len(groups)
    # Silent e: "make" is one syllable, but "the" and "be" are still one.
    if word.endswith("e") and not word.endswith(("le", "ee", "ye")) and count > 1:
        count -= 1
    # "-ed" after a non-dental consonant is not its own syllable: "walked".
    if word.endswith("ed") and len(word) > 3 and word[-3] not in "td" and count > 1:
        count -= 1
    return max(1, count)


def flesch_reading_ease(sentences: list[Span], tokens: list[str]) -> float:
    """206.835 - 1.015 * (words/sentence) - 84.6 * (syllables/word)."""
    if not sentences or not tokens:
        return 0.0
    words_per_sentence = len(tokens) / len(sentences)
    syllables_per_word = sum(count_syllables(t) for t in tokens) / len(tokens)
    score = 206.835 - 1.015 * words_per_sentence - 84.6 * syllables_per_word
    return round(max(0.0, min(120.0, score)), 1)


# Bare conjunctions count as transitions only when they OPEN a sentence.
# Mid-sentence they are ordinary conjunction, not discourse signalling, and
# counting them anywhere inflates the figure badly: an early version read 72%
# on text a real Yoast report scored at 30.8%, because nearly every sentence
# contains "and" somewhere. Distinctive connectives like "however" do function
# as transitions wherever they appear, so those are matched anywhere.
_INITIAL_ONLY = {
    "and", "so", "but", "also", "then", "because", "while", "since",
    "before", "after", "until", "as",
}


def _has_transition(sentence: str) -> tuple[bool, bool]:
    """Return (has any transition, the transition is a formal one)."""
    lowered = f" {sentence.lower().strip()} "

    def opens_with(phrase: str) -> bool:
        return lowered.startswith(f" {phrase} ") or lowered.startswith(f" {phrase}, ")

    def contains(phrase: str) -> bool:
        return f" {phrase} " in lowered or f" {phrase}, " in lowered

    formal = any(opens_with(p) or contains(p) for p in FORMAL_TRANSITIONS)

    multiword = {p for p in ALL_TRANSITIONS if " " in p}
    other = any(contains(p) for p in multiword)
    other = other or any(
        opens_with(p) if p in _INITIAL_ONLY else contains(p)
        for p in ALL_TRANSITIONS
        if " " not in p
    )

    return (formal or other), formal


def _is_passive(sentence: str) -> bool:
    """A be-form followed within two words by a past participle.

    Deliberately shallow. A real parser would be more accurate but this is the
    same shape of heuristic Yoast itself uses, and it agrees with Yoast closely
    enough that the percentage lands in the same band.
    """
    words = [w.lower() for w in re.findall(r"[A-Za-z']+", sentence)]
    for index, word in enumerate(words):
        if word not in _BE_FORMS:
            continue
        for candidate in words[index + 1:index + 3]:
            if candidate in _IRREGULAR_PARTICIPLES:
                return True
            if (
                candidate.endswith("ed")
                and len(candidate) > 4
                and candidate not in _ADJECTIVAL_ED
            ):
                return True
    return False


def strip_headings(text: str) -> str:
    """Remove markdown heading lines from the body before sentence analysis.

    A heading has no terminal punctuation, so the segmenter glues it to the
    paragraph that follows and reports the pair as one very long sentence.
    Yoast analyses headings separately for the same reason: they are structure,
    not prose. Subheading distribution still reads them from the full text.
    """
    return _SUBHEADING.sub("", text)


def analyse(text: str) -> dict[str, object]:
    """Run every check and return values plus a pass/warn/fail per check."""
    body = strip_headings(text)
    sentences = split_sentences(body)
    paragraphs = split_paragraphs(body)
    tokens = word_tokens(body)
    total_sentences = max(1, len(sentences))

    long_sentences = [s for s in sentences if s.word_count > MAX_SENTENCE_WORDS]
    long_share = 100.0 * len(long_sentences) / total_sentences

    transition_flags = [_has_transition(s.text) for s in sentences]
    with_transition = sum(1 for has, _ in transition_flags if has)
    formal_count = sum(1 for _, formal in transition_flags if formal)
    transition_share = 100.0 * with_transition / total_sentences

    passive_count = sum(1 for s in sentences if _is_passive(s.text))
    passive_share = 100.0 * passive_count / total_sentences

    long_paragraphs = [p for p in paragraphs if p.word_count > MAX_PARAGRAPH_WORDS]

    subheadings = _SUBHEADING.findall(text)
    gaps = _subheading_gaps(text)

    starts = [(s.words[0].lower() if s.words else "") for s in sentences]
    max_run = _longest_run(starts)

    flesch = flesch_reading_ease(sentences, tokens)

    def verdict(ok: bool, near: bool = False) -> str:
        return "good" if ok else ("warn" if near else "bad")

    # Naming the offending sentences is what makes a failing check actionable.
    # "17% of sentences are passive" gives a rewriter nothing to work with;
    # three example sentences give it something to fix.
    passive_examples = [s.text for s in sentences if _is_passive(s.text)][:4]
    long_examples = [s.text for s in long_sentences][:4]
    no_transition = [
        s.text for s, (has, _) in zip(sentences, transition_flags) if not has
    ][:4]

    return {
        "word_count": len(tokens),
        "sentence_count": len(sentences),
        "checks": [
            {
                "id": "word_count",
                "label": "Text length",
                "value": float(len(tokens)),
                "target": f"at least {MIN_WORD_COUNT} words",
                "status": verdict(len(tokens) >= MIN_WORD_COUNT),
                "detail": f"{len(tokens)} words.",
            },
            {
                "id": "flesch",
                "label": "Flesch Reading Ease",
                "value": flesch,
                "target": f"{GOOD_FLESCH:.0f} or higher",
                "status": verdict(flesch >= GOOD_FLESCH, flesch >= 50),
                "detail": _flesch_label(flesch),
            },
            {
                "id": "long_sentences",
                "label": "Sentence length",
                "value": round(long_share, 1),
                "target": f"at most {MAX_LONG_SENTENCE_SHARE:.0f}% over {MAX_SENTENCE_WORDS} words",
                "status": verdict(long_share <= MAX_LONG_SENTENCE_SHARE,
                                  long_share <= MAX_LONG_SENTENCE_SHARE + 5),
                "detail": f"{len(long_sentences)} of {len(sentences)} sentences are over "
                          f"{MAX_SENTENCE_WORDS} words.",
                "offenders": long_examples,
            },
            {
                "id": "paragraphs",
                "label": "Paragraph length",
                "value": float(len(long_paragraphs)),
                "target": f"none over {MAX_PARAGRAPH_WORDS} words",
                "status": verdict(not long_paragraphs),
                "detail": "No paragraphs are too long." if not long_paragraphs
                          else f"{len(long_paragraphs)} paragraph(s) exceed "
                               f"{MAX_PARAGRAPH_WORDS} words.",
            },
            {
                "id": "transitions",
                "label": "Transition words",
                "value": round(transition_share, 1),
                "target": f"at least {MIN_TRANSITION_SHARE:.0f}% of sentences",
                "status": verdict(transition_share >= MIN_TRANSITION_SHARE,
                                  transition_share >= MIN_TRANSITION_SHARE - 10),
                # The extra clause is the part that matters for this product.
                "detail": f"{round(transition_share, 1)}% of sentences carry one"
                          + (f", but {formal_count} use formal connectives that "
                             "detectors treat as machine tells."
                             if formal_count else "."),
                "offenders": no_transition,
            },
            {
                "id": "passive",
                "label": "Passive voice",
                "value": round(passive_share, 1),
                "target": f"at most {MAX_PASSIVE_SHARE:.0f}% of sentences",
                "status": verdict(passive_share <= MAX_PASSIVE_SHARE,
                                  passive_share <= MAX_PASSIVE_SHARE + 5),
                "detail": f"{passive_count} of {len(sentences)} sentences are passive.",
                "offenders": passive_examples,
            },
            {
                "id": "subheadings",
                "label": "Subheading distribution",
                "value": float(max(gaps) if gaps else len(tokens)),
                "target": f"a subheading at least every {MAX_SUBHEADING_GAP_WORDS} words",
                "status": verdict(
                    bool(subheadings) and all(g <= MAX_SUBHEADING_GAP_WORDS for g in gaps)
                ),
                "detail": "No subheadings found. Add at least one."
                          if not subheadings
                          else f"{len(subheadings)} subheading(s); longest run without "
                               f"one is {max(gaps) if gaps else 0} words.",
            },
            {
                "id": "consecutive_starts",
                "label": "Consecutive sentence openings",
                "value": float(max_run),
                "target": f"at most {MAX_CONSECUTIVE_SAME_START} in a row",
                "status": verdict(max_run <= MAX_CONSECUTIVE_SAME_START),
                "detail": f"Longest run of sentences starting with the same word: {max_run}.",
            },
        ],
    }


def _flesch_label(score: float) -> str:
    if score >= 80:
        return "Easy to read."
    if score >= 60:
        return "Fairly easy to read."
    if score >= 50:
        return "Fairly difficult to read."
    return "Difficult to read. Shorten sentences and use plainer words."


def _subheading_gaps(text: str) -> list[int]:
    """Words between consecutive subheadings, and after the last one."""
    positions = [m.start() for m in _SUBHEADING.finditer(text)]
    if not positions:
        return []
    bounds = positions + [len(text)]
    return [len(word_tokens(text[bounds[i]:bounds[i + 1]])) for i in range(len(positions))]


def _longest_run(values: list[str]) -> int:
    longest = current = 0
    previous = None
    for value in values:
        if value and value == previous:
            current += 1
        else:
            current = 1
        previous = value
        longest = max(longest, current)
    return longest
