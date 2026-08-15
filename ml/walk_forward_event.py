from __future__ import annotations

import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import HORIZON, ROUND_TRIP_COST, build_features
from train_event_model import FUTURES_DIR, candidate_events, event_labels, model_for, nonoverlap_metrics, select_threshold
from train_lightgbm import add_derivatives_context, add_higher_timeframe_context, normalize_kline_columns


def prepare(interval: str = "4h") -> tuple[pd.DataFrame, list[str]]:
    raw = normalize_kline_columns(pd.read_csv(FUTURES_DIR / f"BTCUSDT_{interval}.csv"))
    frame, names = build_features(raw)
    frame, names = add_higher_timeframe_context(interval, frame, names, FUTURES_DIR)
    frame, names = add_derivatives_context(frame, names, FUTURES_DIR)
    frame = pd.concat([frame, candidate_events(frame)], axis=1)
    frame = pd.concat([frame, event_labels(frame)], axis=1)
    model_features = [*names, "event_side", "event_strength", "long_score", "short_score", "event_type"]
    usable = frame[(frame["event_side"] != 0)].dropna(subset=model_features + ["event_success", "event_return", "bars_to_exit"]).iloc[:-HORIZON].copy()
    return usable, model_features


def run(separate_sides: bool = True) -> dict:
    frame, features = prepare("4h")
    matrix = frame[features].replace([np.inf, -np.inf], np.nan).fillna(0).to_numpy(float)
    labels = frame["event_success"].to_numpy(int)
    returns = frame["event_return"].to_numpy(float)
    bars = frame["bars_to_exit"].to_numpy(float)
    timestamps = frame["open_time"].to_numpy(np.int64)
    start = int(len(frame) * 0.50)
    step = max(120, int(len(frame) * 0.08))
    probability = np.full(len(frame), np.nan)
    threshold = np.full(len(frame), np.nan)
    folds = []

    params = {"num_leaves": 31, "learning_rate": 0.03, "min_child_samples": 150, "feature_fraction": 0.8}
    for fold_index, train_end in enumerate(range(start, len(frame) - 80, step)):
        prediction_start = train_end + HORIZON
        prediction_end = min(prediction_start + step, len(frame))
        calibration_size = min(400, max(160, int(train_end * 0.12)))
        fit_end = train_end - calibration_size - HORIZON
        calibration_start = fit_end + HORIZON
        if fit_end < 800 or prediction_end - prediction_start < 40:
            continue
        calibration_probability = np.full(train_end - calibration_start, np.nan)
        prediction_probability = np.full(prediction_end - prediction_start, np.nan)
        side_values = (-1, 1) if separate_sides else (0,)
        for side_index, side_value in enumerate(side_values):
            train_mask = np.arange(fit_end)
            calibration_mask = np.arange(calibration_start, train_end)
            prediction_mask = np.arange(prediction_start, prediction_end)
            if separate_sides:
                train_mask = train_mask[frame["event_side"].to_numpy(int)[:fit_end] == side_value]
                calibration_side = frame["event_side"].to_numpy(int)[calibration_start:train_end] == side_value
                prediction_side = frame["event_side"].to_numpy(int)[prediction_start:prediction_end] == side_value
                calibration_indices = calibration_mask[calibration_side]
                prediction_indices = prediction_mask[prediction_side]
            else:
                calibration_indices = calibration_mask
                prediction_indices = prediction_mask
                calibration_side = np.ones(len(calibration_mask), dtype=bool)
                prediction_side = np.ones(len(prediction_mask), dtype=bool)
            if len(train_mask) < 400 or len(np.unique(labels[train_mask])) < 2:
                continue
            model = model_for(params, 5000 + fold_index * 10 + side_index)
            model.fit(
                matrix[train_mask], labels[train_mask],
                eval_set=[(matrix[calibration_indices], labels[calibration_indices])], eval_metric="auc",
                callbacks=[lgb.early_stopping(100, verbose=False)],
            )
            calibration_probability[calibration_side] = model.predict_proba(matrix[calibration_indices])[:, 1]
            prediction_probability[prediction_side] = model.predict_proba(matrix[prediction_indices])[:, 1]
        valid_calibration = np.isfinite(calibration_probability)
        selected_quantile, selected_threshold, calibration_metrics = select_threshold(
            calibration_probability[valid_calibration], labels[calibration_start:train_end][valid_calibration], returns[calibration_start:train_end][valid_calibration],
            bars[calibration_start:train_end][valid_calibration], max(8, int(valid_calibration.sum() * 0.015)),
        )
        probability[prediction_start:prediction_end] = prediction_probability
        threshold[prediction_start:prediction_end] = selected_threshold
        folds.append({
            "fit_end": int(timestamps[fit_end - 1]), "prediction_start": int(timestamps[prediction_start]),
            "prediction_end": int(timestamps[prediction_end - 1]), "quantile": selected_quantile, "threshold": selected_threshold,
            "calibration": calibration_metrics, "prediction_rows": int(prediction_end - prediction_start),
        })

    mask = np.isfinite(probability)
    raw_signal = np.zeros(int(mask.sum()), dtype=int)
    selected_probability = probability[mask]
    selected_threshold = threshold[mask]
    raw_signal[selected_probability >= selected_threshold] = 1
    metrics = nonoverlap_metrics(raw_signal.astype(float), labels[mask], returns[mask], bars[mask], 0.5)
    auc = roc_auc_score(labels[mask], selected_probability)
    result = {
        "rows": int(len(frame)), "predicted_rows": int(mask.sum()), "folds": folds,
        "auc": float(auc), **metrics,
        "approved": metrics["signals"] >= 40 and metrics["hit_rate"] >= 0.55 and metrics["mean_return"] > 0 and metrics["profit_factor"] > 1.15 and auc > 0.52,
        "cost": ROUND_TRIP_COST,
        "method": f"expanding-window retrain; {'separate long/short models; ' if separate_sides else ''}calibration and prediction separated by 24 event rows",
    }
    Path("reports/walk-forward-event.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


if __name__ == "__main__":
    run()
