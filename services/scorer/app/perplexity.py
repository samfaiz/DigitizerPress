"""Per-token surprisal, the backbone of the score.

Two interchangeable backends behind one interface:

  transformer  A real causal LM. Accurate, needs torch, ~1s per 500 words on
               CPU with distilgpt2. This is what you ship.
  heuristic    A unigram model over English word frequencies. Needs no torch
               and no download beyond the wordfreq data. Much weaker, but it
               keeps the whole pipeline runnable and testable from a cold
               clone, and it is honest about being an approximation.

Both return token surprisals annotated with character offsets, so the caller
can fold them onto sentences without a second pass over the model.
"""

from __future__ import annotations

import math
import threading
import re
from dataclasses import dataclass
from functools import lru_cache

from .config import settings

_WORD_RE = re.compile(r"\S+")


@dataclass(frozen=True)
class TokenScore:
    """Negative log-likelihood of one token, in nats, with its char span."""

    start: int
    end: int
    nll: float


class Backend:
    name = "base"
    model = "none"

    def score_tokens(self, text: str) -> list[TokenScore]:
        raise NotImplementedError


class HeuristicBackend(Backend):
    """Unigram surprisal from corpus word frequencies.

    This captures vocabulary rarity but nothing about context, so it cannot
    see the thing that actually distinguishes model text: that each word is
    predictable *given the ones before it*. Treat its numbers as indicative.
    """

    name = "heuristic"
    model = "wordfreq-en-unigram"

    # Surprisal assigned to a token absent from the frequency list. Roughly
    # equivalent to a probability of 1e-7, which is where wordfreq bottoms out.
    _OOV_NLL = 16.1

    def __init__(self) -> None:
        try:
            from wordfreq import word_frequency

            self._freq = word_frequency
        except ImportError:  # pragma: no cover - depends on install extras
            self._freq = None

    def _token_nll(self, raw: str) -> float:
        word = raw.strip(".,;:!?\"'()[]—–…“”‘’").lower()
        if not word:
            return 2.0  # bare punctuation is highly predictable
        if self._freq is None:
            # Last-resort fallback: longer words are rarer. Crude but monotone.
            return min(self._OOV_NLL, 1.5 + 0.9 * len(word))
        probability = self._freq(word, "en")
        if probability <= 0:
            return self._OOV_NLL
        return min(self._OOV_NLL, -math.log(probability))

    def score_tokens(self, text: str) -> list[TokenScore]:
        return [
            TokenScore(match.start(), match.end(), self._token_nll(match.group(0)))
            for match in _WORD_RE.finditer(text)
        ]


class TransformerBackend(Backend):
    """True conditional surprisal from a causal language model.

    Inference is serialised behind a lock. This is not caution, it is a fix
    for a reproducible crash.

    FastAPI runs a plain ``def`` endpoint in a threadpool, so several /score
    requests execute the forward pass at the same time. On Apple's MPS
    backend that aborts the whole process:

        failed assertion _status < MTLCommandBufferStatusCommitted
        at line 323 in -[IOGPUMetalCommandBuffer setCurrentCommandEncoder:]

    Metal command buffers are not safe to drive from several threads, and
    CUDA offers no ordering guarantee here either. Nothing noticed while
    articles were generated one at a time, because nothing ever sent two
    scoring requests at once. The bulk path sends eight, and killed the
    scorer twice at the same phase, losing every article in the job along
    with the batches already paid for.

    The lock costs throughput and that is the right trade: a scorer that
    serialises is slower, a scorer that dies takes the job with it.
    """

    name = "transformer"

    def __init__(self, model_name: str) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self._torch = torch
        self._lock = threading.Lock()
        self.model = model_name
        self._device = self._pick_device(torch)
        self._tokenizer = AutoTokenizer.from_pretrained(model_name)
        self._model = AutoModelForCausalLM.from_pretrained(model_name)
        self._model.to(self._device)
        self._model.eval()

    @staticmethod
    def _pick_device(torch) -> str:
        if settings.force_cpu:
            return "cpu"
        if torch.cuda.is_available():
            return "cuda"
        if torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    @property
    def device(self) -> str:
        return self._device

    def score_tokens(self, text: str) -> list[TokenScore]:
        torch = self._torch
        encoded = self._tokenizer(
            text,
            return_offsets_mapping=True,
            return_tensors="pt",
            truncation=False,
        )
        input_ids = encoded["input_ids"][0]
        offsets = encoded["offset_mapping"][0].tolist()
        total = int(input_ids.shape[0])
        if total < 2:
            return []

        window = min(settings.window, getattr(self._model.config, "n_positions", 1024))
        stride = max(1, min(settings.stride, window - 1))

        # NaN marks "not yet scored". The first window to cover a token wins,
        # because earlier windows give that token the most left context.
        nlls: list[float] = [math.nan] * total
        begin = 0

        # Held across every window of this document rather than taken per
        # window. Interleaving two documents' windows is exactly the pattern
        # that crashed Metal, and re-acquiring per window would allow it.
        with self._lock:
            while begin < total - 1:
                end = min(begin + window, total)
                chunk = input_ids[begin:end].unsqueeze(0).to(self._device)

                with torch.no_grad():
                    logits = self._model(chunk).logits[0]

                # logits[i] predicts token i+1, so align targets by one.
                log_probs = torch.log_softmax(logits[:-1].float(), dim=-1)
                targets = chunk[0][1:]
                token_nll = -log_probs.gather(1, targets.unsqueeze(1)).squeeze(1)

                for offset, value in enumerate(token_nll.tolist()):
                    position = begin + 1 + offset
                    if math.isnan(nlls[position]):
                        nlls[position] = value

                if end >= total:
                    break
                begin += stride

        scores: list[TokenScore] = []
        for position, value in enumerate(nlls):
            if math.isnan(value):
                continue  # token 0 has no prediction, and nothing else should be unset
            start, stop = offsets[position]
            if stop <= start:
                continue  # special tokens carry an empty span
            scores.append(TokenScore(int(start), int(stop), float(value)))
        return scores


@lru_cache(maxsize=1)
def get_backend() -> Backend:
    """Build the configured backend once and reuse it for the process life."""
    if settings.backend == "transformer":
        return TransformerBackend(settings.model_name)
    return HeuristicBackend()
