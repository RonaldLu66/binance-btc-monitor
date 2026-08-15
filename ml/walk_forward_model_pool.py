from __future__ import annotations

import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import HORIZON
from train_event_model import nonoverlap_metrics, raw_rule_baseline, select_threshold
from walk_forward_event import prepare


def models(seed: int) -> dict:
    return {
        "lightgbm": lgb.LGBMClassifier(
            objective="binary", metric="auc", n_estimators=700, num_leaves=31, learning_rate=0.03,
            min_child_samples=120, feature_fraction=0.8, subsample=0.8, subsample_freq=1,
            reg_alpha=0.2, reg_lambda=1.5, random_state=seed, n_jobs=-1, verbosity=-1,
        ),
        "extra_trees": ExtraTreesClassifier(
            n_estimators=500, max_depth=8, min_samples_leaf=30, max_features=0.65,
            class_weight="balanced", random_state=seed, n_jobs=-1,
        ),
        "hist_gradient_boosting": HistGradientBoostingClassifier(
            learning_rate=0.04, max_iter=350, max_leaf_nodes=21, min_samples_leaf=40,
            l2_regularization=1.0, random_state=seed,
        ),
        "logistic": make_pipeline(
            StandardScaler(), LogisticRegression(C=0.2, class_weight="balanced", max_iter=1000, random_state=seed),
        ),
    }


def run() -> dict:
    frame, features = prepare("4h")
    matrix = frame[features].replace([np.inf, -np.inf], np.nan).fillna(0).to_numpy(float)
    labels = frame["event_success"].to_numpy(int)
    returns = frame["event_return"].to_numpy(float)
    bars = frame["bars_to_exit"].to_numpy(float)
    timestamps = frame["open_time"].to_numpy(np.int64)
    sides = frame["event_side"].to_numpy(int)
    start = int(len(frame) * 0.50)
    step = max(120, int(len(frame) * 0.08))
    all_probabilities = np.full(len(frame), np.nan)
    all_thresholds = np.full(len(frame), np.nan)
    fold_records = []

    for fold_index, train_end in enumerate(range(start, len(frame) - 80, step)):
        prediction_start = train_end + HORIZON
        prediction_end = min(prediction_start + step, len(frame))
        calibration_size = min(420, max(180, int(train_end * 0.14)))
        fit_end = train_end - calibration_size - HORIZON
        calibration_start = fit_end + HORIZON
        if fit_end < 800 or prediction_end - prediction_start < 40:
            continue

        candidates = []
        for separate_sides in (False, True):
            for model_name, estimator_template in models(7000 + fold_index).items():
                calibration_probability = np.full(train_end - calibration_start, np.nan)
                prediction_probability = np.full(prediction_end - prediction_start, np.nan)
                side_values = (-1, 1) if separate_sides else (0,)
                fitted = 0
                for side_value in side_values:
                    train_indices = np.arange(fit_end)
                    calibration_indices = np.arange(calibration_start, train_end)
                    prediction_indices = np.arange(prediction_start, prediction_end)
                    if separate_sides:
                        train_side = sides[:fit_end] == side_value
                        calibration_side = sides[calibration_start:train_end] == side_value
                        prediction_side = sides[prediction_start:prediction_end] == side_value
                        train_indices = train_indices[train_side]
                        selected_calibration = calibration_indices[calibration_side]
                        selected_prediction = prediction_indices[prediction_side]
                    else:
                        calibration_side = np.ones(len(calibration_indices), dtype=bool)
                        prediction_side = np.ones(len(prediction_indices), dtype=bool)
                        selected_calibration = calibration_indices
                        selected_prediction = prediction_indices
                    if len(train_indices) < 400 or len(np.unique(labels[train_indices])) < 2:
                        continue
                    estimator = models(7000 + fold_index + side_value + 2)[model_name]
                    if model_name == "lightgbm":
                        estimator.fit(
                            matrix[train_indices], labels[train_indices],
                            eval_set=[(matrix[selected_calibration], labels[selected_calibration])], eval_metric="auc",
                            callbacks=[lgb.early_stopping(80, verbose=False)],
                        )
                    else:
                        estimator.fit(matrix[train_indices], labels[train_indices])
                    calibration_probability[calibration_side] = estimator.predict_proba(matrix[selected_calibration])[:, 1]
                    prediction_probability[prediction_side] = estimator.predict_proba(matrix[selected_prediction])[:, 1]
                    fitted += 1
                if not fitted or not np.isfinite(calibration_probability).all() or not np.isfinite(prediction_probability).all():
                    continue
                quantile, threshold, calibration_metrics = select_threshold(
                    calibration_probability, labels[calibration_start:train_end], returns[calibration_start:train_end],
                    bars[calibration_start:train_end], max(10, int(calibration_size * 0.018)),
                )
                calibration_auc = roc_auc_score(labels[calibration_start:train_end], calibration_probability)
                baseline = raw_rule_baseline(labels[calibration_start:train_end], returns[calibration_start:train_end], bars[calibration_start:train_end])
                eligible = (
                    calibration_metrics["signals"] >= 10
                    and calibration_metrics["mean_return"] > baseline["mean_return"]
                    and calibration_metrics["profit_factor"] > max(1.05, baseline["profit_factor"])
                    and calibration_auc > 0.50
                )
                score = calibration_metrics["mean_return"] * np.sqrt(calibration_metrics["signals"]) + max(calibration_auc - 0.5, 0) * 0.01
                candidates.append({
                    "model": model_name, "separate_sides": separate_sides, "quantile": quantile, "threshold": threshold,
                    "calibration": calibration_metrics, "calibration_auc": float(calibration_auc), "baseline": baseline,
                    "eligible": eligible, "score": float(score), "prediction_probability": prediction_probability,
                })

        eligible = [candidate for candidate in candidates if candidate["eligible"]]
        if not eligible:
            fold_records.append({"prediction_start": int(timestamps[prediction_start]), "prediction_end": int(timestamps[prediction_end - 1]), "selected": None, "candidate_count": len(candidates)})
            continue
        selected = max(eligible, key=lambda candidate: candidate["score"])
        all_probabilities[prediction_start:prediction_end] = selected.pop("prediction_probability")
        all_thresholds[prediction_start:prediction_end] = selected["threshold"]
        fold_records.append({
            "prediction_start": int(timestamps[prediction_start]), "prediction_end": int(timestamps[prediction_end - 1]),
            "selected": selected, "candidate_count": len(candidates),
        })

    mask = np.isfinite(all_probabilities)
    selected_probabilities = all_probabilities[mask]
    raw_signal = (selected_probabilities >= all_thresholds[mask]).astype(float)
    metrics = nonoverlap_metrics(raw_signal, labels[mask], returns[mask], bars[mask], 0.5) if mask.any() else raw_rule_baseline(np.array([]), np.array([]), np.array([]))
    auc = roc_auc_score(labels[mask], selected_probabilities) if mask.any() and len(np.unique(labels[mask])) > 1 else 0.5
    baseline = raw_rule_baseline(labels[mask], returns[mask], bars[mask]) if mask.any() else {}
    approved = (
        metrics["signals"] >= 40 and metrics["mean_return"] > baseline.get("mean_return", 0)
        and metrics["profit_factor"] > max(1.15, baseline.get("profit_factor", 0) * 1.10) and auc > 0.52
    )
    result = {
        "rows": int(len(frame)), "predicted_rows": int(mask.sum()), "folds": fold_records,
        "auc": float(auc), **metrics, "raw_rule_baseline": baseline, "approved": approved,
        "method": "causal expanding-window model pool; algorithm and threshold selected only on preceding calibration window",
    }
    Path("reports/walk-forward-model-pool.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


if __name__ == "__main__":
    run()
