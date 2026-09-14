"""FastAPI surface for the scoring service.

This service is intentionally stateless, unauthenticated and private. It is
never exposed to the browser. The NestJS gateway is the only client, and it
owns rate limiting, caching and the word cap.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .config import settings
from .perplexity import get_backend
from .schemas import (
    ScoreRequest,
    ScoreResponse,
    SimilarityRequest,
    SimilarityResponse,
)
from .similarity import compare
from .scoring import load_weights, score_text

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("scorer")

class Health(BaseModel):
    status: str
    backend: str
    model: str
    calibrated: bool
    warm: bool


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Load the model at boot, not on the first user request.

    On the transformer backend the first forward pass costs several seconds of
    weight loading. Paying that during startup means the first real request is
    fast, and the health check does not go green until the service can serve.
    """
    backend = get_backend()
    score_text("Warm up the graph with a short sentence.", with_sentences=False)
    logger.info("scorer ready: backend=%s model=%s", backend.name, backend.model)
    yield


app = FastAPI(
    title="AI Humaniser Scorer",
    version="0.1.0",
    description="Perplexity, burstiness and surface-feature detection scoring.",
    lifespan=lifespan,
)


@app.get("/health", response_model=Health)
def health() -> Health:
    backend = get_backend()
    _, _, calibrated = load_weights()
    return Health(
        status="ok",
        backend=backend.name,
        model=backend.model,
        calibrated=calibrated,
        warm=True,
    )


@app.post("/similarity", response_model=SimilarityResponse)
def similarity(request: SimilarityRequest) -> SimilarityResponse:
    """Compare two texts for surviving topical vocabulary.

    Lives here because the weighting needs word frequency data this service
    already loads. It is a separate concern from detection, and it is on a
    separate endpoint, so the rewriter still never reads the detector.
    """
    result = compare(request.original.strip(), request.rewritten.strip())
    return SimilarityResponse(**result)


@app.post("/score", response_model=ScoreResponse)
def score(request: ScoreRequest) -> ScoreResponse:
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="text is empty")
    if len(text) > settings.max_chars:
        raise HTTPException(
            status_code=413,
            detail=f"text exceeds {settings.max_chars} characters",
        )
    return score_text(text, with_sentences=request.sentences)
