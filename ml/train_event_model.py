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
from pipeline import DATA_DIR, HORIZON, MODEL_DIR, REPORT_DIR, ROUND_TRIP_COST, build_features, ensure_dirs
from train_lightgbm import PARAM_GRID, add_derivatives_context, add_higher_timeframe_context, normalize_kline_columns


FUTURES_DIR = DATA_DIR / "futures"
TARGET_ATR = 1.5
STOP_ATR = 1.0


def candidate_events(frame: pd.DataFrame) -> pd.DataFrame:
    def onset(column: str) -> pd.Series:
        active = frame[column] > 0
        return (active & ~active.shift(1, fill_value=False)).astype(float)

    volume_momentum_long = ((frame["macd_hist_delta"] > 0) & (frame["relative_volume"] > 1.2)).astype(float)
    volume_momentum_short = ((frame["macd_hist_delta"] < 0) & (frame["relative_volume"] > 1.2)).astype(float)
    volume_momentum_long_onset = ((volume_momentum_long > 0) & ~(volume_momentum_long.shift(1, fill_value=0) > 0)).astype(float)
    volume_momentum_short_onset = ((volume_momentum_short > 0) & ~(volume_momentum_short.shift(1, fill_value=0) > 0)).astype(float)
    long_score = (
        1.0 * frame["macd_gold_cross"]
        + 1.4 * onset("macd_bull_divergence")
        + 1.0 * onset("rsi_bull_divergence")
        + 1.5 * frame["spring_break_low"]
        + 1.2 * frame["breakout_up_20"]
        + 1.2 * onset("head_shoulders_bottom")
        + 0.5 * volume_momentum_long_onset
    )
    short_score = (
        1.0 * frame["macd_death_cross"]
        + 1.4 * onset("macd_bear_divergence")
        + 1.0 * onset("rsi_bear_divergence")
        + 1.5 * frame["false_breakout_up"]
        + 1.2 * frame["breakout_down_20"]
        + 1.2 * onset("head_shoulders_top")
        + 0.5 * volume_momentum_short_onset
    )
    side = np.where(long_score > short_score, 1, np.where(short_score > long_score, -1, 0))
    event_strength = np.maximum(long_score, short_score)
    event_type = np.select(
        [frame["spring_break_low"] > 0, frame["false_breakout_up"] > 0, frame["breakout_up_20"] > 0, frame["breakout_down_20"] > 0,
         onset("macd_bull_divergence") > 0, onset("macd_bear_divergence") > 0, frame["macd_gold_cross"] > 0, frame["macd_death_cross"] > 0,
         onset("head_shoulders_bottom") > 0, onset("head_shoulders_top") > 0,
         volume_momentum_long_onset > 0, volume_momentum_short_onset > 0],
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], default=0,
    )
    return pd.DataFrame({"event_side": side, "event_strength": event_strength, "long_score": long_score, "short_score": short_score, "event_type": event_type}, index=frame.index)


def event_labels(frame: pd.DataFrame) -> pd.DataFrame:
    side = frame["event_side"].to_numpy(int)
    open_values = frame["open"].to_numpy(float)
    high_values = frame["high"].to_numpy(float)
    low_values = frame["low"].to_numpy(float)
    close_values = frame["close"].to_numpy(float)
    atr_values = frame["atr"].to_numpy(float)
    labels = np.full(len(frame), np.nan)
    realized = np.full(len(frame), np.nan)
    bars_to_exit = np.full(len(frame), np.nan)
    ambiguous = np.zeros(len(frame), dtype=bool)
    for index in range(len(frame) - HORIZON - 1):
        if side[index] == 0 or not np.isfinite(atr_values[index]) or atr_values[index] <= 0:
            continue
        entry = open_values[index + 1]
        target = entry + side[index] * TARGET_ATR * atr_values[index]
        stop = entry - side[index] * STOP_ATR * atr_values[index]
        outcome = None
        exit_price = close_values[index + HORIZON]
        exit_bars = HORIZON
        for future_index in range(index + 1, index + HORIZON + 1):
            target_hit = high_values[future_index] >= target if side[index] > 0 else low_values[future_index] <= target
            stop_hit = low_values[future_index] <= stop if side[index] > 0 else high_values[future_index] >= stop
            if target_hit and stop_hit:
                ambiguous[index] = True
                break
            if target_hit:
                outcome = 1
                exit_price = target
                exit_bars = future_index - index
                break
            if stop_hit:
                outcome = 0
                exit_price = stop
                exit_bars = future_index - index
                break
        if ambiguous[index]:
            continue
        if outcome is None:
            directional_return = side[index] * (exit_price / entry - 1)
            outcome = int(directional_return > ROUND_TRIP_COST)
        labels[index] = outcome
        realized[index] = side[index] * (exit_price / entry - 1) - ROUND_TRIP_COST
        bars_to_exit[index] = exit_bars
    return pd.DataFrame({"event_success": labels, "event_return": realized, "bars_to_exit": bars_to_exit, "event_ambiguous": ambiguous}, index=frame.index)


def event_folds(length: int) -> list[tuple[np.ndarray, np.ndarray]]:
    output = []
    initial = int(length * 0.45)
    validation = int(length * 0.11)
    for fold in range(4):
        train_end = initial + fold * validation
        validation_start = train_end + HORIZON
        validation_end = min(validation_start + validation, length)
        if validation_end - validation_start >= 80:
            output.append((np.arange(train_end), np.arange(validation_start, validation_end)))
    return output


def model_for(params: dict, seed: int) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        objective="binary", metric="auc", n_estimators=1000, subsample=0.80, subsample_freq=1,
        reg_alpha=0.2, reg_lambda=1.5, random_state=seed, n_jobs=-1, verbosity=-1, **params,
    )


def nonoverlap_metrics(probability: np.ndarray, labels: np.ndarray, returns: np.ndarray, bars: np.ndarray, threshold: float) -> dict:
    selected = []
    next_available = 0
    for index, value in enumerate(probability):
        if index < next_available or value < threshold:
            continue
        selected.append(index)
        next_available = index + max(1, int(bars[index]))
    if not selected:
        return {"signals": 0, "hit_rate": 0.0, "coverage": 0.0, "mean_return": 0.0, "profit_factor": 0.0, "total_return_additive": 0.0, "max_drawdown_additive": 0.0}
    index = np.asarray(selected, dtype=int)
    trade_returns = returns[index]
    wins = trade_returns[trade_returns > 0].sum()
    losses = -trade_returns[trade_returns < 0].sum()
    equity = np.cumsum(trade_returns)
    running_peak = np.maximum.accumulate(np.r_[0.0, equity])[-len(equity):]
    return {
        "signals": int(len(index)), "hit_rate": float(labels[index].mean()), "coverage": float(len(index) / len(labels)),
        "mean_return": float(trade_returns.mean()), "profit_factor": float(wins / max(losses, 1e-12)),
        "total_return_additive": float(trade_returns.sum()), "max_drawdown_additive": float((equity - running_peak).min()),
    }


def raw_rule_baseline(labels: np.ndarray, returns: np.ndarray, bars: np.ndarray) -> dict:
    return nonoverlap_metrics(np.ones(len(labels)), labels, returns, bars, 0.5)


def select_threshold(probability: np.ndarray, labels: np.ndarray, returns: np.ndarray, bars: np.ndarray, minimum: int) -> tuple[float, float, dict]:
    best = None
    for quantile in (0.40, 0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.925, 0.95):
        threshold = float(np.quantile(probability, quantile))
        metrics = nonoverlap_metrics(probability, labels, returns, bars, float(threshold))
        if metrics["signals"] < minimum:
            continue
        score = metrics["mean_return"] * np.sqrt(metrics["signals"])
        if metrics["profit_factor"] < 1:
            score -= 1
        if best is None or score > best[0]:
            best = (score, float(quantile), float(threshold), metrics)
    if best is None:
        threshold = float(np.quantile(probability, 0.80))
        return 0.80, threshold, nonoverlap_metrics(probability, labels, returns, bars, threshold)
    return best[1], best[2], best[3]


def train(interval: str = "4h") -> dict:
    raw = normalize_kline_columns(pd.read_csv(FUTURES_DIR / f"BTCUSDT_{interval}.csv"))
    frame, feature_names = build_features(raw)
    frame, feature_names = add_higher_timeframe_context(interval, frame, feature_names, FUTURES_DIR)
    frame, feature_names = add_derivatives_context(frame, feature_names, FUTURES_DIR)
    frame = pd.concat([frame, candidate_events(frame)], axis=1)
    frame = pd.concat([frame, event_labels(frame)], axis=1)
    model_features = [*feature_names, "event_side", "event_strength", "long_score", "short_score", "event_type"]
    usable = frame[(frame["event_side"] != 0)].dropna(subset=model_features + ["event_success", "event_return", "bars_to_exit"]).iloc[:-HORIZON].copy()
    features = usable[model_features].replace([np.inf, -np.inf], np.nan).fillna(0).to_numpy(float)
    labels = usable["event_success"].to_numpy(int)
    returns = usable["event_return"].to_numpy(float)
    bars = usable["bars_to_exit"].to_numpy(float)
    times = usable["open_time"].to_numpy(np.int64)
    development_end = int(len(usable) * 0.80)
    evaluation_start = development_end + HORIZON
    dev_x, dev_y, dev_returns, dev_bars = features[:development_end], labels[:development_end], returns[:development_end], bars[:development_end]
    eval_x, eval_y, eval_returns, eval_bars = features[evaluation_start:], labels[evaluation_start:], returns[evaluation_start:], bars[evaluation_start:]
    candidates = []
    for parameter_index, params in enumerate(PARAM_GRID):
        probabilities = np.full(len(dev_y), np.nan)
        aucs = []
        for fold_index, (train_index, validation_index) in enumerate(event_folds(len(dev_y))):
            model = model_for(params, 3000 + parameter_index * 10 + fold_index)
            model.fit(dev_x[train_index], dev_y[train_index], eval_set=[(dev_x[validation_index], dev_y[validation_index])], eval_metric="auc", callbacks=[lgb.early_stopping(80, verbose=False)])
            probabilities[validation_index] = model.predict_proba(dev_x[validation_index])[:, 1]
            aucs.append(roc_auc_score(dev_y[validation_index], probabilities[validation_index]))
        mask = np.isfinite(probabilities)
        quantile, threshold, metrics = select_threshold(probabilities[mask], dev_y[mask], dev_returns[mask], dev_bars[mask], max(15, int(mask.sum() * 0.01)))
        candidates.append({"params": params, "quantile": quantile, "threshold": threshold, "metrics": metrics, "auc": float(np.mean(aucs)), "rows": int(mask.sum())})
    candidates.sort(key=lambda item: (item["metrics"]["mean_return"] > 0, item["metrics"]["profit_factor"], item["auc"]), reverse=True)
    selected = candidates[0]
    split = int(development_end * 0.88)
    calibration_start = split + HORIZON
    final = model_for(selected["params"], 20260814)
    final.fit(features[:split], labels[:split], eval_set=[(features[calibration_start:development_end], labels[calibration_start:development_end])], eval_metric="auc", callbacks=[lgb.early_stopping(100, verbose=False)])
    calibration_probability = final.predict_proba(features[calibration_start:development_end])[:, 1]
    calibrated_quantile, calibrated_threshold, calibration = select_threshold(
        calibration_probability, labels[calibration_start:development_end], returns[calibration_start:development_end],
        bars[calibration_start:development_end], max(12, int((development_end - calibration_start) * 0.02)),
    )
    eval_probability = final.predict_proba(eval_x)[:, 1]
    evaluation = nonoverlap_metrics(eval_probability, eval_y, eval_returns, eval_bars, calibrated_threshold)
    evaluation_auc = roc_auc_score(eval_y, eval_probability)
    minimum_signals = max(15, int(len(eval_y) * 0.015))
    baseline = raw_rule_baseline(eval_y, eval_returns, eval_bars)
    approved = (
        evaluation["signals"] >= minimum_signals
        and evaluation["profit_factor"] > max(1.15, baseline["profit_factor"] * 1.10)
        and evaluation["mean_return"] > max(0, baseline["mean_return"])
        and evaluation_auc > 0.52
    )
    model_path = MODEL_DIR / f"event_lightgbm_{interval}.txt"
    final.booster_.save_model(model_path)
    artifact = {
        "interval": interval, "model_type": "LightGBM meta-label model for technical pattern events",
        "trained_at": datetime.now(timezone.utc).isoformat(), "rows": int(len(usable)), "features": model_features,
        "development_rows": development_end, "evaluation_rows": int(len(eval_y)), "evaluation_start": int(times[evaluation_start]), "evaluation_end": int(times[-1]),
        "selected_params": selected["params"], "walk_forward_quantile": selected["quantile"], "walk_forward_threshold": selected["threshold"], "calibrated_quantile": calibrated_quantile, "threshold": calibrated_threshold,
        "walk_forward": {"auc": selected["auc"], **selected["metrics"], "rows": selected["rows"]},
        "calibration": {**calibration, "rows": int(development_end - calibration_start)},
        "evaluation": {"auc": float(evaluation_auc), **evaluation}, "raw_rule_baseline": baseline,
        "quality_gate": {"status": "approved" if approved else "watch_only", "approved_for_live_display": approved, "minimum_signals": minimum_signals},
        "target": {"target_atr": TARGET_ATR, "stop_atr": STOP_ATR, "horizon_bars": HORIZON, "entry": "next_bar_open", "cost": ROUND_TRIP_COST},
        "feature_importance": sorted(zip(model_features, final.feature_importances_.tolist()), key=lambda pair: pair[1], reverse=True)[:20],
        "caveat": "Development event-model evaluation. Requires future paper-trading before capital use.",
    }
    (MODEL_DIR / f"event_lightgbm_{interval}.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
    return artifact


def main() -> None:
    ensure_dirs()
    artifact = train("4h")
    report = [
        "# 4小时形态事件机器学习模型", "",
        f"- 形态事件样本：{artifact['rows']}", f"- 走步AUC：{artifact['walk_forward']['auc']:.3f}",
        f"- 评估AUC：{artifact['evaluation']['auc']:.3f}", f"- 评估独立信号：{artifact['evaluation']['signals']}",
        f"- 评估命中率：{artifact['evaluation']['hit_rate']:.2%}", f"- 扣成本单笔均值：{artifact['evaluation']['mean_return']:.3%}",
        f"- 盈亏因子：{artifact['evaluation']['profit_factor']:.2f}", f"- 状态：{artifact['quality_gate']['status']}", "",
        "候选事件由MACD金叉死叉与背离、RSI背离、破低翻/假突破、放量突破、头肩结构和量价确认触发；模型只判断该事件是否值得参与。",
    ]
    (REPORT_DIR / "event-model-report.md").write_text("\n".join(report), encoding="utf-8")
    print(json.dumps({"walk_forward": artifact["walk_forward"], "evaluation": artifact["evaluation"], "quality_gate": artifact["quality_gate"], "feature_importance": artifact["feature_importance"][:12]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
