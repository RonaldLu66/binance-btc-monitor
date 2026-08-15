from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

from pipeline import BARRIER_ATR, DATA_DIR, HORIZON, MODEL_DIR, REPORT_DIR, ROUND_TRIP_COST, build_features, ensure_dirs


PARAM_GRID = [
    {"num_leaves": 15, "learning_rate": 0.03, "min_child_samples": 100, "feature_fraction": 0.75},
    {"num_leaves": 31, "learning_rate": 0.03, "min_child_samples": 150, "feature_fraction": 0.80},
    {"num_leaves": 31, "learning_rate": 0.05, "min_child_samples": 250, "feature_fraction": 0.90},
    {"num_leaves": 63, "learning_rate": 0.03, "min_child_samples": 300, "feature_fraction": 0.75},
    {"num_leaves": 63, "learning_rate": 0.05, "min_child_samples": 400, "feature_fraction": 0.90},
]

CONTEXT_MAP = {"15m": ["1h", "4h", "1d"], "1h": ["4h", "1d"], "4h": ["1d"], "1d": []}
CONTEXT_FEATURES = [
    "return_6", "return_24", "ema_gap_20", "ema_gap_50", "ema_20_50", "ema_50_200",
    "macd_atr", "macd_hist_atr", "macd_hist_delta", "macd_above_zero", "macd_gold_cross", "macd_death_cross",
    "macd_bull_divergence", "macd_bear_divergence", "rsi_14", "rsi_bull_divergence", "rsi_bear_divergence",
    "relative_volume", "obv_slope_20", "cmf_20", "taker_buy_ratio", "range_position_20", "range_contraction",
    "breakout_up_20", "breakout_down_20", "false_breakout_up", "spring_break_low", "flag_pole_ratio",
]


def normalize_kline_columns(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.rename(columns={"count": "trades", "taker_buy_volume": "taker_base", "taker_buy_quote_volume": "taker_quote"})


def make_outcomes(frame: pd.DataFrame) -> pd.DataFrame:
    open_values = frame["open"].to_numpy(float)
    high_values = frame["high"].to_numpy(float)
    low_values = frame["low"].to_numpy(float)
    close_values = frame["close"].to_numpy(float)
    atr_values = frame["atr"].to_numpy(float)
    labels = np.full(len(frame), np.nan)
    underlying_returns = np.full(len(frame), np.nan)
    ambiguous = np.zeros(len(frame), dtype=bool)
    for index in range(len(frame) - HORIZON - 1):
        if not np.isfinite(atr_values[index]) or atr_values[index] <= 0:
            continue
        entry = open_values[index + 1]
        upper = entry + BARRIER_ATR * atr_values[index]
        lower = entry - BARRIER_ATR * atr_values[index]
        exit_price = close_values[index + HORIZON]
        for future_index in range(index + 1, index + HORIZON + 1):
            hit_upper = high_values[future_index] >= upper
            hit_lower = low_values[future_index] <= lower
            if hit_upper and hit_lower:
                ambiguous[index] = True
                break
            if hit_upper:
                exit_price = upper
                break
            if hit_lower:
                exit_price = lower
                break
        if ambiguous[index]:
            continue
        realized = exit_price / entry - 1
        underlying_returns[index] = realized
        labels[index] = 1 if realized > 0 else 0
    return pd.DataFrame({"label_up": labels, "underlying_return": underlying_returns, "ambiguous": ambiguous}, index=frame.index)


def add_higher_timeframe_context(interval: str, frame: pd.DataFrame, feature_names: list[str], data_directory: Path = DATA_DIR) -> tuple[pd.DataFrame, list[str]]:
    enriched = frame.copy().sort_values("close_time")
    enriched["close_time"] = pd.to_numeric(enriched["close_time"], errors="coerce")
    names = list(feature_names)
    for higher_interval in CONTEXT_MAP[interval]:
        higher_path = data_directory / f"BTCUSDT_{higher_interval}.csv"
        if not higher_path.exists():
            continue
        higher_raw = normalize_kline_columns(pd.read_csv(higher_path))
        higher_frame, higher_names = build_features(higher_raw)
        selected = [name for name in CONTEXT_FEATURES if name in higher_names]
        higher_frame["close_time"] = pd.to_numeric(higher_frame["close_time"], errors="coerce")
        rename = {name: f"ctx_{higher_interval}_{name}" for name in selected}
        context = higher_frame[["close_time", *selected]].rename(columns=rename).sort_values("close_time")
        enriched = pd.merge_asof(enriched, context, on="close_time", direction="backward", allow_exact_matches=True)
        names.extend(rename.values())
    return enriched.sort_values("open_time").reset_index(drop=True), names


def add_derivatives_context(frame: pd.DataFrame, feature_names: list[str], data_directory: Path) -> tuple[pd.DataFrame, list[str]]:
    funding_path = data_directory / "BTCUSDT_funding.csv"
    metrics_path = data_directory / "BTCUSDT_metrics_5m.csv"
    if not funding_path.exists() or not metrics_path.exists():
        return frame, feature_names
    enriched = frame.copy().sort_values("close_time")
    enriched["close_time"] = pd.to_numeric(enriched["close_time"], errors="coerce")
    funding = pd.read_csv(funding_path)
    funding["calc_time"] = pd.to_numeric(funding["calc_time"], errors="coerce")
    funding = funding.rename(columns={"calc_time": "funding_time"}).sort_values("funding_time")
    enriched = pd.merge_asof(enriched, funding[["funding_time", "last_funding_rate"]], left_on="close_time", right_on="funding_time", direction="backward")
    metrics = pd.read_csv(metrics_path)
    metrics["metric_time"] = pd.to_datetime(metrics["create_time"], utc=True).map(lambda value: int(value.timestamp() * 1000))
    metric_columns = [
        "sum_open_interest", "sum_open_interest_value", "count_toptrader_long_short_ratio",
        "sum_toptrader_long_short_ratio", "count_long_short_ratio", "sum_taker_long_short_vol_ratio",
    ]
    metrics[metric_columns] = metrics[metric_columns].apply(pd.to_numeric, errors="coerce")
    metrics = metrics.sort_values("metric_time")
    enriched = pd.merge_asof(enriched, metrics[["metric_time", *metric_columns]], left_on="close_time", right_on="metric_time", direction="backward")
    names = list(feature_names)

    def add(name: str, values: pd.Series) -> None:
        enriched[name] = values.replace([np.inf, -np.inf], np.nan)
        names.append(name)

    funding_rate = pd.to_numeric(enriched["last_funding_rate"], errors="coerce")
    add("funding_rate", funding_rate)
    add("funding_change", funding_rate.diff())
    add("funding_sum_3", funding_rate.rolling(3).sum())
    add("funding_z_30", (funding_rate - funding_rate.rolling(30).mean()) / funding_rate.rolling(30).std().replace(0, np.nan))
    open_interest = enriched["sum_open_interest"]
    open_interest_value = enriched["sum_open_interest_value"]
    add("oi_log", np.log(open_interest))
    add("oi_change_1", np.log(open_interest).diff())
    add("oi_change_3", np.log(open_interest).diff(3))
    add("oi_change_6", np.log(open_interest).diff(6))
    add("oi_value_change_3", np.log(open_interest_value).diff(3))
    for column in metric_columns[2:]:
        series = enriched[column]
        add(column, np.log(series.clip(lower=1e-6)))
        add(f"{column}_change", np.log(series.clip(lower=1e-6)).diff())
        add(f"{column}_z_30", (series - series.rolling(30).mean()) / series.rolling(30).std().replace(0, np.nan))
    price_return = np.log(enriched["close"]).diff()
    oi_change = np.log(open_interest).diff()
    add("price_oi_same_direction", np.sign(price_return) * np.sign(oi_change))
    add("price_up_oi_up", ((price_return > 0) & (oi_change > 0)).astype(float))
    add("price_down_oi_up", ((price_return < 0) & (oi_change > 0)).astype(float))
    add("price_up_oi_down", ((price_return > 0) & (oi_change < 0)).astype(float))
    add("price_down_oi_down", ((price_return < 0) & (oi_change < 0)).astype(float))
    return enriched.sort_values("open_time").reset_index(drop=True), names


def time_folds(length: int, folds: int = 4) -> list[tuple[np.ndarray, np.ndarray]]:
    initial = int(length * 0.48)
    validation_size = int(length * 0.10)
    output = []
    for fold in range(folds):
        train_end = initial + fold * validation_size
        validation_start = train_end + HORIZON
        validation_end = min(validation_start + validation_size, length)
        if validation_end - validation_start < 100:
            break
        output.append((np.arange(train_end), np.arange(validation_start, validation_end)))
    return output


def model_for(params: dict, seed: int) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        objective="binary", n_estimators=800, max_depth=-1,
        subsample=0.80, subsample_freq=1, reg_alpha=0.15, reg_lambda=1.0,
        random_state=seed, n_jobs=-1, verbosity=-1, **params,
    )


def metrics_from_signals(actual: np.ndarray, raw_signal: np.ndarray, returns: np.ndarray) -> dict[str, float | int]:
    selected_indices = []
    next_available = 0
    for index, value in enumerate(raw_signal):
        if index < next_available or value == 0:
            continue
        selected_indices.append(index)
        next_available = index + HORIZON
    selected = np.asarray(selected_indices, dtype=int)
    signal = raw_signal[selected] if len(selected) else np.array([], dtype=int)
    trade_returns = signal * returns[selected] - ROUND_TRIP_COST if len(selected) else np.array([], dtype=float)
    actual_direction = np.where(actual == 1, 1, -1)
    hits = signal == actual_direction[selected] if len(selected) else np.array([], dtype=bool)
    if not len(selected):
        return {"signals": 0, "coverage": 0.0, "hit_rate": 0.0, "mean_return": 0.0, "profit_factor": 0.0, "total_return_additive": 0.0, "max_drawdown_additive": 0.0}
    wins = trade_returns[trade_returns > 0].sum()
    losses = -trade_returns[trade_returns < 0].sum()
    equity = np.cumsum(trade_returns)
    drawdown = equity - np.maximum.accumulate(np.r_[0.0, equity])[-len(equity):]
    return {
        "signals": int(len(selected)), "coverage": float(len(selected) / len(actual)), "hit_rate": float(hits.mean()),
        "mean_return": float(trade_returns.mean()), "profit_factor": float(wins / max(losses, 1e-12)),
        "total_return_additive": float(trade_returns.sum()), "max_drawdown_additive": float(drawdown.min()),
    }


def causal_quantile_signals(probabilities: np.ndarray, history: np.ndarray, quantile: float, window: int = 4000) -> np.ndarray:
    previous = list(np.asarray(history, dtype=float))
    signals = np.zeros(len(probabilities), dtype=int)
    for index, probability in enumerate(probabilities):
        recent = np.asarray(previous[-window:], dtype=float)
        threshold = float(np.quantile(np.abs(recent - 0.5), quantile)) if len(recent) else 0.10
        if abs(probability - 0.5) >= threshold:
            signals[index] = 1 if probability > 0.5 else -1
        previous.append(float(probability))
    return signals


def choose_quantile(actual: np.ndarray, probabilities: np.ndarray, returns: np.ndarray, minimum_signals: int) -> tuple[float, dict]:
    seed_size = max(100, int(len(probabilities) * 0.20))
    seed_probability = probabilities[:seed_size]
    evaluation_probability = probabilities[seed_size:]
    evaluation_actual = actual[seed_size:]
    evaluation_returns = returns[seed_size:]
    best = None
    for quantile in (0.70, 0.75, 0.80, 0.85, 0.90, 0.925, 0.95, 0.975):
        raw_signal = causal_quantile_signals(evaluation_probability, seed_probability, quantile)
        metrics = metrics_from_signals(evaluation_actual, raw_signal, evaluation_returns)
        if metrics["signals"] < minimum_signals:
            continue
        score = float(metrics["mean_return"]) * np.sqrt(float(metrics["signals"]))
        if float(metrics["hit_rate"]) < 0.50:
            score -= 1
        if best is None or score > best[0]:
            best = (score, float(quantile), metrics)
    if best is None:
        raw_signal = causal_quantile_signals(evaluation_probability, seed_probability, 0.90)
        return 0.90, metrics_from_signals(evaluation_actual, raw_signal, evaluation_returns)
    return best[1], best[2]


def train_one(interval: str, data_directory: Path = DATA_DIR, model_prefix: str = "lightgbm") -> dict:
    raw = normalize_kline_columns(pd.read_csv(data_directory / f"BTCUSDT_{interval}.csv"))
    frame, feature_names = build_features(raw)
    frame, feature_names = add_higher_timeframe_context(interval, frame, feature_names, data_directory)
    frame, feature_names = add_derivatives_context(frame, feature_names, data_directory)
    outcomes = make_outcomes(frame)
    frame = pd.concat([frame, outcomes], axis=1)
    usable = frame.dropna(subset=feature_names + ["label_up", "underlying_return"]).iloc[:-HORIZON].copy()
    features = usable[feature_names].replace([np.inf, -np.inf], np.nan).fillna(0).to_numpy(float)
    labels = usable["label_up"].to_numpy(int)
    returns = usable["underlying_return"].to_numpy(float)
    times = usable["open_time"].to_numpy(np.int64)

    development_end = int(len(usable) * 0.82)
    development_x, development_y, development_returns = features[:development_end], labels[:development_end], returns[:development_end]
    evaluation_x, evaluation_y, evaluation_returns = features[development_end + HORIZON:], labels[development_end + HORIZON:], returns[development_end + HORIZON:]
    folds = time_folds(len(development_y))
    minimum_signals = max(30, int(len(development_y) * 0.015))
    candidates = []

    for parameter_index, params in enumerate(PARAM_GRID):
        oof_probability = np.full(len(development_y), np.nan)
        fold_auc = []
        for fold_index, (train_index, validation_index) in enumerate(folds):
            model = model_for(params, 1100 + parameter_index * 10 + fold_index)
            model.fit(
                development_x[train_index], development_y[train_index],
                eval_set=[(development_x[validation_index], development_y[validation_index])],
                callbacks=[lgb.early_stopping(60, verbose=False)],
            )
            probability = model.predict_proba(development_x[validation_index])[:, 1]
            oof_probability[validation_index] = probability
            fold_auc.append(roc_auc_score(development_y[validation_index], probability))
        mask = np.isfinite(oof_probability)
        quantile, metrics = choose_quantile(development_y[mask], oof_probability[mask], development_returns[mask], minimum_signals)
        candidates.append({"params": params, "quantile": quantile, "metrics": metrics, "mean_auc": float(np.mean(fold_auc)), "oof_rows": int(mask.sum())})

    candidates.sort(key=lambda item: (item["metrics"]["mean_return"] > 0, item["metrics"]["profit_factor"], item["mean_auc"]), reverse=True)
    selected = candidates[0]
    final = model_for(selected["params"], 20260813)
    split = int(development_end * 0.88)
    calibration_start = split + HORIZON
    final.fit(
        features[:split], labels[:split], eval_set=[(features[calibration_start:development_end], labels[calibration_start:development_end])],
        callbacks=[lgb.early_stopping(80, verbose=False)],
    )
    calibration_probabilities = final.predict_proba(features[calibration_start:development_end])[:, 1]
    probabilities = final.predict_proba(evaluation_x)[:, 1]
    evaluation_signal = causal_quantile_signals(probabilities, calibration_probabilities, selected["quantile"])
    evaluation_metrics = metrics_from_signals(evaluation_y, evaluation_signal, evaluation_returns)
    evaluation_auc = roc_auc_score(evaluation_y, probabilities)
    majority_accuracy = float(max(evaluation_y.mean(), 1 - evaluation_y.mean()))
    minimum_evaluation_signals = max(20, int(len(evaluation_y) * 0.01))
    approved = (
        evaluation_metrics["signals"] >= minimum_evaluation_signals
        and evaluation_metrics["hit_rate"] >= 0.515
        and evaluation_metrics["mean_return"] > 0
        and evaluation_metrics["profit_factor"] > 1.05
        and evaluation_auc > 0.51
    )

    model_path = MODEL_DIR / f"{model_prefix}_{interval}.txt"
    final.booster_.save_model(model_path)
    artifact = {
        "interval": interval, "trained_at": datetime.now(timezone.utc).isoformat(), "model_type": "LightGBM binary direction with confidence gate",
        "features": feature_names, "rows": int(len(usable)), "development_rows": int(development_end), "evaluation_rows": int(len(evaluation_y)),
        "evaluation_start": int(times[development_end + HORIZON]), "evaluation_end": int(times[-1]),
        "selected_params": selected["params"], "selected_confidence_quantile": selected["quantile"],
        "walk_forward": {"mean_auc": selected["mean_auc"], **selected["metrics"], "rows": selected["oof_rows"]},
        "calibration": {"rows": int(development_end - calibration_start), "method": "causal rolling confidence quantile; labels unused"},
        "evaluation": {"auc": float(evaluation_auc), "majority_accuracy": majority_accuracy, **evaluation_metrics},
        "quality_gate": {"approved_for_live_display": approved, "minimum_evaluation_signals": minimum_evaluation_signals, "status": "approved" if approved else "watch_only"},
        "label": {"entry": "next_bar_open", "horizon_bars": HORIZON, "barrier_atr": BARRIER_ATR, "same_bar_both_barriers": "excluded"},
        "cost": {"round_trip_fraction": ROUND_TRIP_COST},
        "caveat": "Development walk-forward evaluation; prior linear baseline exposed the same broad terminal period. Future paper-trading is required before capital use.",
        "feature_importance": sorted(zip(feature_names, final.feature_importances_.tolist()), key=lambda pair: pair[1], reverse=True)[:15],
    }
    artifact["data_source"] = "Binance Futures UM archive" if data_directory != DATA_DIR else "Binance Spot public API archive"
    (MODEL_DIR / f"{model_prefix}_{interval}.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
    return artifact


def write_summary(artifacts: list[dict]) -> None:
    lines = [
        "# LightGBM形态模型开发期走步回测", "",
        "模型使用53项价格、MACD、背离、量价和形态特征。训练区间采用扩展窗口走步验证，并在训练与验证之间留出24根K线隔离带。", "",
        "| 周期 | 样本 | 走步AUC | 评估AUC | 信号数 | 覆盖率 | 方向命中率 | 单笔均值(扣成本) | 盈亏因子 | 状态 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for artifact in artifacts:
        evaluation = artifact["evaluation"]
        lines.append(
            f"| {artifact['interval']} | {artifact['rows']} | {artifact['walk_forward']['mean_auc']:.3f} | {evaluation['auc']:.3f} | {evaluation['signals']} | {evaluation['coverage']:.2%} | {evaluation['hit_rate']:.2%} | {evaluation['mean_return']:.4%} | {evaluation['profit_factor']:.2f} | {artifact['quality_gate']['status']} |"
        )
    lines.extend([
        "", "## 质量边界", "",
        "- 评估已计入0.08%往返成本，但没有计入资金费率、滑点扩大和强平风险。",
        "- 这是开发期走步回测，不是可承诺的未来成功率。第一轮线性基线已观察过相同大范围尾部数据，因此不能再称其为完全未触碰测试集。",
        "- 只有状态为approved的周期允许在页面显示方向概率；watch_only只展示为研究结果。",
        "- 上线前仍需至少一个月实时纸面交易与数据漂移监控。",
    ])
    (REPORT_DIR / "lightgbm-report.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    ensure_dirs()
    artifacts = []
    for interval in ("15m", "1h", "4h", "1d"):
        artifact = train_one(interval)
        artifacts.append(artifact)
        print(interval, artifact["walk_forward"], artifact["evaluation"], artifact["quality_gate"], flush=True)
    write_summary(artifacts)


if __name__ == "__main__":
    main()
