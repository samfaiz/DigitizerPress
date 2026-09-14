"""Fit real calibration weights from a labelled corpus.

The priors in app/scoring.py rank documents correctly but their absolute
percentages mean nothing. This script replaces them with fitted values.

Corpus format: a CSV with two columns.

    text,label
    "Some paragraph...",0        # 0 = human
    "Some paragraph...",1        # 1 = machine generated

Where to get one:
  HC3        https://huggingface.co/datasets/Hello-SimpleAI/HC3
  RAID       https://huggingface.co/datasets/liamdugan/raid
  Or build your own by pairing human text with regenerations of it.

Critical: generate the machine half with the SAME models your users will
paste from. A detector fitted on 2023 output will misjudge 2026 output.

Usage:
    uv run --extra train python scripts/train.py corpus.csv --out app/weights.json

Then restart the service. It picks the file up automatically and flips
`calibrated` to true in the health check and every score response.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.features import surface_features  # noqa: E402
from app.perplexity import get_backend  # noqa: E402
from app.scoring import PRIORS, fold_tokens_into_sentences  # noqa: E402
from app.segment import split_sentences  # noqa: E402

# Order is fixed so coefficients stay aligned with feature names on the way out.
FEATURE_ORDER = [
    "log_perplexity",
    "burstiness",
    "sentence_length_cv",
    "repeated_trigram_rate",
    "tell_word_rate",
    "em_dash_rate",
    "punctuation_variety",
    "paragraph_length_cv",
    "type_token_ratio",
    "mean_word_length",
]

# Must match the log1p flags used at inference, or the fitted coefficients
# will be applied to a differently shaped feature and silently mispredict.
LOG1P_FEATURES = {"tell_word_rate", "em_dash_rate"}


def extract(text: str) -> dict[str, float]:
    backend = get_backend()
    sentences = split_sentences(text)
    tokens = backend.score_tokens(text)
    buckets = fold_tokens_into_sentences(tokens, sentences)

    all_nll = [token.nll for token in tokens]
    mean_nll = statistics.fmean(all_nll) if all_nll else 0.0
    per_sentence = [
        statistics.fmean(values) if values else mean_nll for values in buckets
    ]
    burstiness = (
        statistics.pstdev(per_sentence) if len(per_sentence) > 1 else 0.0
    )

    return {
        "log_perplexity": mean_nll,
        "burstiness": burstiness,
        **surface_features(text, sentences),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", help="CSV with text,label columns")
    parser.add_argument("--out", default="app/weights.json")
    parser.add_argument("--min-words", type=int, default=40,
                        help="Drop rows shorter than this. Short text is noise.")
    args = parser.parse_args()

    try:
        import numpy as np
        import pandas as pd
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import classification_report, roc_auc_score
        from sklearn.model_selection import train_test_split
    except ImportError:
        print("Install the training extras first:", file=sys.stderr)
        print("  uv pip install --extra train -e .", file=sys.stderr)
        return 1

    frame = pd.read_csv(args.corpus)
    if not {"text", "label"}.issubset(frame.columns):
        print("corpus must have 'text' and 'label' columns", file=sys.stderr)
        return 1

    frame = frame[frame["text"].astype(str).str.split().str.len() >= args.min_words]
    print(f"{len(frame)} rows after the length filter")

    rows, labels = [], []
    for position, record in enumerate(frame.itertuples(index=False), start=1):
        features = extract(str(record.text))
        vector = []
        for name in FEATURE_ORDER:
            value = features.get(name, 0.0)
            vector.append(np.log1p(max(0.0, value)) if name in LOG1P_FEATURES else value)
        rows.append(vector)
        labels.append(int(record.label))
        if position % 250 == 0:
            print(f"  featurised {position}/{len(frame)}")

    matrix = np.array(rows, dtype=float)
    target = np.array(labels, dtype=int)

    # Standardise here rather than in a sklearn pipeline, because the runtime
    # applies (value - center) / scale by hand and needs these two numbers
    # written into the weights file.
    centers = matrix.mean(axis=0)
    scales = matrix.std(axis=0)
    scales[scales < 1e-6] = 1.0
    standardised = (matrix - centers) / scales

    x_train, x_test, y_train, y_test = train_test_split(
        standardised, target, test_size=0.2, stratify=target, random_state=42
    )
    model = LogisticRegression(max_iter=2000, C=1.0)
    model.fit(x_train, y_train)

    probabilities = model.predict_proba(x_test)[:, 1]
    print(f"\nheld-out ROC AUC: {roc_auc_score(y_test, probabilities):.4f}")
    print(classification_report(y_test, model.predict(x_test),
                                target_names=["human", "ai"]))

    block = {
        "bias": float(model.intercept_[0]),
        "terms": {
            name: {
                "center": float(centers[index]),
                "scale": float(scales[index]),
                "weight": float(model.coef_[0][index]),
                "log1p": name in LOG1P_FEATURES,
            }
            for index, name in enumerate(FEATURE_ORDER)
        },
    }

    out_path = Path(args.out)
    # Preserve the other backend's block if one was fitted earlier.
    payload = {}
    if out_path.exists():
        try:
            payload = json.loads(out_path.read_text())
        except ValueError:
            payload = {}
    for backend_name in PRIORS:
        payload.setdefault(backend_name, None)
    payload[settings.backend] = block
    payload = {key: value for key, value in payload.items() if value}

    out_path.write_text(json.dumps(payload, indent=2))
    print(f"\nwrote {out_path} for backend '{settings.backend}'")
    print("Restart the scorer to pick it up.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
