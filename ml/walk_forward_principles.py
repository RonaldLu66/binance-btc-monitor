from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).resolve().parent))
from enhanced_pattern_features import add_principle_features, add_weekly_context
from pipeline import HORIZON, ROUND_TRIP_COST, build_features
from train_event_model import FUTURES_DIR, candidate_events, event_labels, nonoverlap_metrics, raw_rule_baseline, select_threshold
from train_lightgbm import add_derivatives_context, add_higher_timeframe_context, normalize_kline_columns
from walk_forward_model_pool import models


ROOT = Path(__file__).resolve().parents[1]
AUDIT_PATH = ROOT / "reports" / "principle-rule-audit.json"
BASELINE_PATH = ROOT / "reports" / "walk-forward-model-pool.json"
REPORT_PATH = ROOT / "reports" / "walk-forward-principles.json"


def prepare() -> tuple[pd.DataFrame, dict[str, list[str]], list[str]]:
    audit = json.loads(AUDIT_PATH.read_text(encoding="utf-8"))
    enabled_rules = set(audit["selected_rules"])
    raw = normalize_kline_columns(pd.read_csv(FUTURES_DIR / "BTCUSDT_4h.csv"))
    frame, baseline_names = build_features(raw)
    frame, principle_names = add_principle_features(frame, baseline_names)
    principle_only = [name for name in principle_names if name not in baseline_names]
    frame, names_with_daily = add_higher_timeframe_context("4h", frame, principle_names, FUTURES_DIR)
    daily_names = [name for name in names_with_daily if name not in principle_names]
    frame, names_with_weekly = add_weekly_context(frame, names_with_daily, FUTURES_DIR)
    weekly_names = [name for name in names_with_weekly if name not in names_with_daily]
    frame, all_names = add_derivatives_context(frame, names_with_weekly, FUTURES_DIR)
    derivative_names = [name for name in all_names if name not in names_with_weekly]

    frame = pd.concat([frame, candidate_events(frame)], axis=1)
    frame = pd.concat([frame, event_labels(frame)], axis=1)
    event_names = ["event_side", "event_strength", "long_score", "short_score", "event_type"]
    selected_rule_features = [name for name in principle_only if name in enabled_rules]
    feature_sets = {
        "baseline": [*baseline_names, *daily_names, *derivative_names, *event_names],
        "selected_rules": [*baseline_names, *daily_names, *derivative_names, *selected_rule_features, *event_names],
        "weekly_context": [*baseline_names, *daily_names, *derivative_names, *selected_rule_features, *weekly_names, *event_names],
        "all_principles": [*all_names, *event_names],
    }
    usable = frame[(frame["event_side"] != 0)].dropna(
        subset=[*feature_sets["baseline"], "event_success", "event_return", "bars_to_exit"]
    ).iloc[:-HORIZON].copy()
    return usable, feature_sets, sorted(enabled_rules)


def selected_indices(probability: np.ndarray, threshold: np.ndarray, bars: np.ndarray) -> np.ndarray:
    selected: list[int] = []
    next_available = 0
    for index, value in enumerate(probability):
        if index < next_available or value < threshold[index]:
            continue
        selected.append(index)
        next_available = index + max(1, int(bars[index]))
    return np.asarray(selected, dtype=int)


def grouped_metrics(
    probability: np.ndarray,
    threshold: np.ndarray,
    labels: np.ndarray,
    returns: np.ndarray,
    bars: np.ndarray,
    timestamps: np.ndarray,
    sides: np.ndarray,
) -> dict:
    def summarize(index: np.ndarray) -> dict:
        if not len(index):
            return {
                "signals": 0, "hit_rate": 0.0, "mean_return": 0.0, "profit_factor": 0.0,
                "total_return_additive": 0.0, "max_drawdown_additive": 0.0,
            }
        trade_returns = returns[index]
        wins = trade_returns[trade_returns > 0].sum()
        losses = -trade_returns[trade_returns < 0].sum()
        equity = np.cumsum(trade_returns)
        running_peak = np.maximum.accumulate(np.r_[0.0, equity])[-len(equity):]
        return {
            "signals": int(len(index)), "hit_rate": float(labels[index].mean()),
            "mean_return": float(trade_returns.mean()), "profit_factor": float(wins / max(losses, 1e-12)),
            "total_return_additive": float(trade_returns.sum()),
            "max_drawdown_additive": float((equity - running_peak).min()),
        }

    selected = selected_indices(probability, threshold, bars)
    rows = []
    if len(selected):
        selected_years = pd.to_datetime(timestamps[selected], unit="ms", utc=True).year.to_numpy()
        for year in np.unique(selected_years):
            index = selected[selected_years == year]
            rows.append({"year": int(year), **summarize(index)})
    direction = {}
    for side, name in ((1, "long"), (-1, "short")):
        index = selected[sides[selected] == side]
        direction[name] = summarize(index)
    eligible_years = [row for row in rows if row["signals"] >= 10]
    return {
        "yearly": rows,
        "direction": direction,
        "positive_year_share": (
            sum(row["mean_return"] > 0 for row in eligible_years) / len(eligible_years)
            if eligible_years else 0.0
        ),
        "eligible_years": len(eligible_years),
    }


def run() -> dict:
    frame, feature_sets, selected_rules = prepare()
    matrices = {
        name: frame[features].replace([np.inf, -np.inf], np.nan).fillna(0).to_numpy(float)
        for name, features in feature_sets.items()
    }
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
        for feature_set, matrix in matrices.items():
            for separate_sides in (False, True):
                for model_name in models(9000 + fold_index):
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
                        if len(train_indices) < 400 or len(selected_calibration) < 20 or len(selected_prediction) == 0:
                            continue
                        if len(np.unique(labels[train_indices])) < 2 or len(np.unique(labels[selected_calibration])) < 2:
                            continue
                        estimator = models(9000 + fold_index + side_value + 2)[model_name]
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
                    quantile, selected_threshold, calibration_metrics = select_threshold(
                        calibration_probability, labels[calibration_start:train_end], returns[calibration_start:train_end],
                        bars[calibration_start:train_end], max(10, int(calibration_size * 0.018)),
                    )
                    calibration_auc = roc_auc_score(labels[calibration_start:train_end], calibration_probability)
                    baseline = raw_rule_baseline(
                        labels[calibration_start:train_end], returns[calibration_start:train_end], bars[calibration_start:train_end]
                    )
                    eligible = (
                        calibration_metrics["signals"] >= 10
                        and calibration_metrics["mean_return"] > baseline["mean_return"]
                        and calibration_metrics["profit_factor"] > max(1.05, baseline["profit_factor"])
                        and calibration_auc > 0.50
                    )
                    score = calibration_metrics["mean_return"] * np.sqrt(calibration_metrics["signals"]) + max(calibration_auc - 0.5, 0) * 0.01
                    candidates.append({
                        "feature_set": feature_set, "model": model_name, "separate_sides": separate_sides,
                        "quantile": quantile, "threshold": selected_threshold, "calibration": calibration_metrics,
                        "calibration_auc": float(calibration_auc), "baseline": baseline, "eligible": eligible,
                        "score": float(score), "prediction_probability": prediction_probability,
                    })

        eligible = [candidate for candidate in candidates if candidate["eligible"]]
        if not eligible:
            fold_records.append({
                "prediction_start": int(timestamps[prediction_start]), "prediction_end": int(timestamps[prediction_end - 1]),
                "selected": None, "candidate_count": len(candidates),
            })
            continue
        baseline_candidates = [candidate for candidate in eligible if candidate["feature_set"] == "baseline"]
        baseline_selected = max(baseline_candidates, key=lambda candidate: candidate["score"]) if baseline_candidates else None
        enhanced_candidates = [candidate for candidate in eligible if candidate["feature_set"] != "baseline"]
        enhanced_selected = max(enhanced_candidates, key=lambda candidate: candidate["score"]) if enhanced_candidates else None
        selected = baseline_selected or enhanced_selected
        if baseline_selected and enhanced_selected:
            calibration_guard = (
                enhanced_selected["score"] >= baseline_selected["score"] + 0.001
                and enhanced_selected["calibration"]["mean_return"] >= baseline_selected["calibration"]["mean_return"]
                and enhanced_selected["calibration"]["profit_factor"] >= baseline_selected["calibration"]["profit_factor"]
                and enhanced_selected["calibration_auc"] >= baseline_selected["calibration_auc"]
            )
            selected = enhanced_selected if calibration_guard else baseline_selected
        all_probabilities[prediction_start:prediction_end] = selected.pop("prediction_probability")
        all_thresholds[prediction_start:prediction_end] = selected["threshold"]
        fold_records.append({
            "prediction_start": int(timestamps[prediction_start]), "prediction_end": int(timestamps[prediction_end - 1]),
            "selected": selected, "candidate_count": len(candidates),
        })

    mask = np.isfinite(all_probabilities)
    probability = all_probabilities[mask]
    threshold = all_thresholds[mask]
    selected_signal = (probability >= threshold).astype(float)
    metrics = nonoverlap_metrics(selected_signal, labels[mask], returns[mask], bars[mask], 0.5)
    auc = roc_auc_score(labels[mask], probability) if mask.any() and len(np.unique(labels[mask])) > 1 else 0.5
    raw_baseline = raw_rule_baseline(labels[mask], returns[mask], bars[mask]) if mask.any() else {}
    stability = grouped_metrics(probability, threshold, labels[mask], returns[mask], bars[mask], timestamps[mask], sides[mask])
    frozen = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    comparison = {
        "auc_delta": float(auc - frozen["auc"]),
        "mean_return_delta": float(metrics["mean_return"] - frozen["mean_return"]),
        "profit_factor_delta": float(metrics["profit_factor"] - frozen["profit_factor"]),
        "signal_delta": int(metrics["signals"] - frozen["signals"]),
    }
    no_quality_regression = (
        comparison["auc_delta"] >= 0
        and comparison["mean_return_delta"] >= 0
        and comparison["profit_factor_delta"] >= 0
    )
    direction_stable = all(
        item["signals"] < 20 or item["mean_return"] > -0.003
        for item in stability["direction"].values()
    )
    approved = (
        metrics["signals"] >= 40 and metrics["mean_return"] > max(0, raw_baseline.get("mean_return", 0))
        and metrics["profit_factor"] > max(1.15, raw_baseline.get("profit_factor", 0) * 1.10)
        and auc > 0.52 and stability["positive_year_share"] >= 0.60 and direction_stable
        and no_quality_regression
    )
    result = {
        "created_at": datetime.now(timezone.utc).isoformat(), "rows": int(len(frame)),
        "predicted_rows": int(mask.sum()), "selected_rules": selected_rules, "feature_sets": feature_sets,
        "folds": fold_records, "auc": float(auc), **metrics, "raw_rule_baseline": raw_baseline,
        "stability": stability, "frozen_baseline": {
            key: frozen[key] for key in ("auc", "signals", "hit_rate", "mean_return", "profit_factor")
        },
        "comparison": comparison, "no_quality_regression": no_quality_regression,
        "approved": approved, "cost": ROUND_TRIP_COST,
        "method": "Causal expanding-window pool. Rule screening ends before evaluation; each fold selects feature set, algorithm, side split, and threshold only from its preceding calibration window.",
    }
    REPORT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "selected_rules": selected_rules, "auc": result["auc"], "signals": result["signals"],
        "hit_rate": result["hit_rate"], "mean_return": result["mean_return"],
        "profit_factor": result["profit_factor"], "comparison": comparison,
        "no_quality_regression": no_quality_regression, "approved": approved,
    }, ensure_ascii=False, indent=2))
    return result


if __name__ == "__main__":
    run()
