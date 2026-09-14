"""Runtime configuration for the scoring service.

Everything is env driven so the service can boot with zero setup on the
heuristic backend and be flipped to the real model with one variable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_root_env() -> None:
    """Load the repo-root .env into os.environ, if one exists.

    Called at import time, before any setting is read. Real environment
    variables win: a value exported in the shell or injected by the deployment
    platform must not be overwritten by a stale file in the working tree.

    Hand-rolled rather than pulling in python-dotenv, because the file this
    reads is the same one the Node services read and the format in use is a
    plain KEY=value list.
    """
    for parent in [Path(__file__).resolve(), *Path(__file__).resolve().parents][:6]:
        candidate = parent / ".env"
        if not candidate.is_file():
            continue
        for raw in candidate.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip().removeprefix("export ").strip()
            value = value.strip()
            # Strip one matched pair of surrounding quotes, nothing more.
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(key, value)
        return


_load_root_env()


def _env_str(key: str, default: str) -> str:
    return os.environ.get(key, default).strip()


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    # "transformer" gives real perplexity and needs torch installed.
    # "heuristic" needs nothing and approximates perplexity from surface stats.
    backend: str = _env_str("SCORER_BACKEND", "heuristic")

    # Any causal LM on the Hugging Face hub. distilgpt2 is the cost/quality
    # sweet spot on CPU; gpt2 is meaningfully better and roughly 3x slower.
    model_name: str = _env_str("SCORER_MODEL", "distilgpt2")

    # Force CPU even when CUDA or MPS is available. Useful for reproducibility.
    force_cpu: bool = _env_str("SCORER_FORCE_CPU", "false").lower() == "true"

    # Sliding window used when the text exceeds the model context.
    window: int = _env_int("SCORER_WINDOW", 512)
    stride: int = _env_int("SCORER_STRIDE", 256)

    # Hard input guard. The gateway enforces its own word cap on top of this.
    max_chars: int = _env_int("SCORER_MAX_CHARS", 60_000)

    # Sentences shorter than this contribute to the document score but are not
    # given an individual verdict, because short spans are pure noise.
    min_sentence_words: int = _env_int("SCORER_MIN_SENTENCE_WORDS", 5)

    # Path to calibration weights produced by scripts/train.py.
    weights_path: str = _env_str("SCORER_WEIGHTS", "app/weights.json")

    # Decision thresholds on the 0-100 output.
    human_ceiling: float = _env_float("SCORER_HUMAN_CEILING", 35.0)
    ai_floor: float = _env_float("SCORER_AI_FLOOR", 65.0)

    # --- External calibration -------------------------------------------
    # Maps this scorer's output onto a commercial detector's scale:
    #   external = slope * local + intercept
    #
    # Fitted on four articles measured by hand on ZeroGPT (R^2 = 0.96):
    #   local 9.6 -> 66.2,  7.5 -> 47.0,  6.8 -> 45.8,  6.2 -> 34.0
    #
    # This exists because the raw score turned out to rank text correctly on a
    # badly compressed scale: two points here are roughly eighteen points
    # there. Reporting the raw number invited exactly the wrong conclusion,
    # that a "6" was nearly clean when it is really a 35.
    #
    # FOUR POINTS IS NOT A CALIBRATION SET. It fixes the scale and nothing
    # more, it is specific to ZeroGPT, and it will drift when they retrain.
    # Re-measure whenever the numbers stop matching.
    calibration_slope: float = _env_float("SCORER_CALIBRATION_SLOPE", 8.795)
    calibration_intercept: float = _env_float("SCORER_CALIBRATION_INTERCEPT", -17.93)
    calibration_target: str = _env_str("SCORER_CALIBRATION_TARGET", "zerogpt")
    calibration_points: int = _env_int("SCORER_CALIBRATION_POINTS", 4)


settings = Settings()
