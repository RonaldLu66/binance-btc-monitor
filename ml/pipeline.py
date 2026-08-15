from __future__ import annotations

import argparse
import csv
import json
import math
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
MODEL_DIR = ROOT / "models"
REPORT_DIR = ROOT / "reports"
BASE_URL = "https://data-api.binance.vision/api/v3/klines"
INTERVAL_MS = {"15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "1d": 24 * 60 * 60_000}
HORIZON = 24
BARRIER_ATR = 1.5
ROUND_TRIP_COST = 0.0008


def ensure_dirs() -> None:
    for directory in (DATA_DIR, MODEL_DIR, REPORT_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def timestamp(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp() * 1000)


def fetch_json(params: dict[str, str | int], retries: int = 4) -> list:
    url = f"{BASE_URL}?{urllib.parse.urlencode(params)}"
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "btc-pattern-ml/1.0"})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as error:
            last_error = error
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Binance request failed: {last_error}")


def download(interval: str, start: str, end: str | None = None) -> Path:
    ensure_dirs()
    output = DATA_DIR / f"BTCUSDT_{interval}.csv"
    start_ms = timestamp(start)
    end_ms = timestamp(end) if end else int(time.time() * 1000)
    if output.exists():
        existing = pd.read_csv(output)
        if not existing.empty:
            start_ms = max(start_ms, int(existing["open_time"].iloc[-1]) + INTERVAL_MS[interval])
    else:
        existing = pd.DataFrame()

    batches: list[pd.DataFrame] = []
    cursor = start_ms
    while cursor < end_ms:
        rows = fetch_json({"symbol": "BTCUSDT", "interval": interval, "startTime": cursor, "endTime": end_ms, "limit": 1000})
        if not rows:
            break
        frame = pd.DataFrame(rows, columns=[
            "open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume", "trades", "taker_base", "taker_quote", "ignore",
        ])
        batches.append(frame)
        next_cursor = int(frame["open_time"].iloc[-1]) + INTERVAL_MS[interval]
        if next_cursor <= cursor:
            break
        cursor = next_cursor
        print(f"{interval}: {datetime.fromtimestamp(cursor / 1000, timezone.utc).date()}", flush=True)
        time.sleep(0.05)

    if batches:
        combined = pd.concat([existing, *batches], ignore_index=True)
    else:
        combined = existing
    if combined.empty:
        raise RuntimeError(f"No data downloaded for {interval}")
    combined = combined.drop_duplicates("open_time").sort_values("open_time")
    numeric = ["open", "high", "low", "close", "volume", "quote_volume", "trades", "taker_base", "taker_quote"]
    combined[numeric] = combined[numeric].apply(pd.to_numeric, errors="coerce")
    combined.to_csv(output, index=False)
    return output


def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False, min_periods=span).mean()


def rolling_slope(series: pd.Series, window: int) -> pd.Series:
    x = np.arange(window, dtype=float)
    x = x - x.mean()
    denominator = float(np.sum(x * x))
    return series.rolling(window).apply(lambda values: float(np.sum(x * (values - values.mean())) / denominator), raw=True)


def build_features(raw: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    frame = raw.copy()
    for column in ["open", "high", "low", "close", "volume", "quote_volume", "taker_base"]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    close, high, low, open_price, volume = frame["close"], frame["high"], frame["low"], frame["open"], frame["volume"]
    previous_close = close.shift(1)
    true_range = pd.concat([(high - low), (high - previous_close).abs(), (low - previous_close).abs()], axis=1).max(axis=1)
    atr = true_range.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    frame["atr"] = atr

    feature_names: list[str] = []
    def add(name: str, values: pd.Series) -> None:
        frame[name] = values.replace([np.inf, -np.inf], np.nan)
        feature_names.append(name)

    log_close = np.log(close)
    for lag in (1, 3, 6, 12, 24):
        add(f"return_{lag}", log_close.diff(lag))
    add("range_atr", (high - low) / atr)
    add("body_atr", (close - open_price) / atr)
    add("upper_wick_atr", (high - np.maximum(open_price, close)) / atr)
    add("lower_wick_atr", (np.minimum(open_price, close) - low) / atr)
    add("close_location", (close - low) / (high - low).replace(0, np.nan))

    ema_values = {period: ema(close, period) for period in (5, 12, 20, 26, 50, 100, 200)}
    for period in (5, 12, 20, 50, 100, 200):
        add(f"ema_gap_{period}", (close - ema_values[period]) / atr)
    add("ema_20_50", (ema_values[20] - ema_values[50]) / atr)
    add("ema_50_200", (ema_values[50] - ema_values[200]) / atr)

    macd = ema_values[12] - ema_values[26]
    macd_signal = ema(macd, 9)
    macd_hist = macd - macd_signal
    gold_cross = ((macd > macd_signal) & (macd.shift(1) <= macd_signal.shift(1))).astype(float)
    death_cross = ((macd < macd_signal) & (macd.shift(1) >= macd_signal.shift(1))).astype(float)
    add("macd_atr", macd / atr)
    add("macd_signal_atr", macd_signal / atr)
    add("macd_hist_atr", macd_hist / atr)
    add("macd_hist_delta", macd_hist.diff() / atr)
    add("macd_above_zero", (macd > 0).astype(float))
    add("macd_gold_cross", gold_cross)
    add("macd_death_cross", death_cross)
    add("macd_water_above_gold", gold_cross * (macd > 0).astype(float))
    add("macd_water_below_gold", gold_cross * (macd < 0).astype(float))
    add("macd_water_above_death", death_cross * (macd > 0).astype(float))
    add("macd_water_below_death", death_cross * (macd < 0).astype(float))

    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    rsi = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    add("rsi_14", (rsi - 50) / 50)

    segment = 20
    prior_low = low.shift(segment).rolling(segment).min()
    recent_low = low.rolling(segment).min()
    prior_high = high.shift(segment).rolling(segment).max()
    recent_high = high.rolling(segment).max()
    prior_macd_low = macd.shift(segment).rolling(segment).min()
    recent_macd_low = macd.rolling(segment).min()
    prior_macd_high = macd.shift(segment).rolling(segment).max()
    recent_macd_high = macd.rolling(segment).max()
    add("macd_bull_divergence", ((recent_low < prior_low * 0.998) & (recent_macd_low > prior_macd_low)).astype(float))
    add("macd_bear_divergence", ((recent_high > prior_high * 1.002) & (recent_macd_high < prior_macd_high)).astype(float))
    prior_rsi_low = rsi.shift(segment).rolling(segment).min()
    recent_rsi_low = rsi.rolling(segment).min()
    prior_rsi_high = rsi.shift(segment).rolling(segment).max()
    recent_rsi_high = rsi.rolling(segment).max()
    add("rsi_bull_divergence", ((recent_low < prior_low * 0.998) & (recent_rsi_low > prior_rsi_low)).astype(float))
    add("rsi_bear_divergence", ((recent_high > prior_high * 1.002) & (recent_rsi_high < prior_rsi_high)).astype(float))

    volume_mean = volume.rolling(20).mean()
    volume_std = volume.rolling(20).std()
    add("volume_zscore", (volume - volume_mean) / volume_std.replace(0, np.nan))
    add("relative_volume", volume / volume_mean.replace(0, np.nan))
    signed_volume = np.sign(delta).fillna(0) * volume
    obv = signed_volume.cumsum()
    add("obv_slope_20", rolling_slope(obv, 20) / volume_mean.replace(0, np.nan))
    money_flow_multiplier = ((close - low) - (high - close)) / (high - low).replace(0, np.nan)
    add("cmf_20", (money_flow_multiplier * volume).rolling(20).sum() / volume.rolling(20).sum())
    add("volume_price_corr_20", delta.rolling(20).corr(volume.pct_change()))
    add("taker_buy_ratio", frame["taker_base"] / volume.replace(0, np.nan))

    resistance = high.shift(1).rolling(20).max()
    support = low.shift(1).rolling(20).min()
    add("breakout_up_20", ((close > resistance) & (volume > volume_mean * 1.2)).astype(float))
    add("breakout_down_20", ((close < support) & (volume > volume_mean * 1.2)).astype(float))
    add("false_breakout_up", ((high > resistance) & (close < resistance)).astype(float))
    add("spring_break_low", ((low < support) & (close > support)).astype(float))
    add("range_position_20", (close - support) / (resistance - support).replace(0, np.nan))
    add("range_contraction", (high.rolling(10).max() - low.rolling(10).min()) / (high.rolling(40).max() - low.rolling(40).min()).replace(0, np.nan))
    add("high_slope_20", rolling_slope(high, 20) / atr)
    add("low_slope_20", rolling_slope(low, 20) / atr)

    block = 12
    left_high = high.shift(block * 2).rolling(block).max()
    head_high = high.shift(block).rolling(block).max()
    right_high = high.rolling(block).max()
    left_low = low.shift(block * 2).rolling(block).min()
    head_low = low.shift(block).rolling(block).min()
    right_low = low.rolling(block).min()
    add("head_shoulders_top", ((head_high > left_high + atr) & (head_high > right_high + atr) & ((left_high - right_high).abs() < 2 * atr)).astype(float))
    add("head_shoulders_bottom", ((head_low < left_low - atr) & (head_low < right_low - atr) & ((left_low - right_low).abs() < 2 * atr)).astype(float))
    add("double_top_similarity", -((left_high - right_high).abs() / atr))
    add("double_bottom_similarity", -((left_low - right_low).abs() / atr))
    prior_move = close.shift(15) - close.shift(35)
    consolidation_range = high.rolling(15).max() - low.rolling(15).min()
    add("flag_pole_ratio", prior_move / consolidation_range.replace(0, np.nan))

    return frame, feature_names


def make_labels(frame: pd.DataFrame, horizon: int = HORIZON, barrier_atr: float = BARRIER_ATR) -> pd.Series:
    open_values = frame["open"].to_numpy(float)
    high_values = frame["high"].to_numpy(float)
    low_values = frame["low"].to_numpy(float)
    close_values = frame["close"].to_numpy(float)
    atr_values = frame["atr"].to_numpy(float)
    labels = np.zeros(len(frame), dtype=np.int8)
    for index in range(len(frame) - horizon - 1):
        if not np.isfinite(atr_values[index]) or atr_values[index] <= 0:
            continue
        entry = open_values[index + 1]
        upper = entry + barrier_atr * atr_values[index]
        lower = entry - barrier_atr * atr_values[index]
        result = 0
        for future_index in range(index + 1, index + horizon + 1):
            hit_upper = high_values[future_index] >= upper
            hit_lower = low_values[future_index] <= lower
            if hit_upper and hit_lower:
                result = 0
                break
            if hit_upper:
                result = 1
                break
            if hit_lower:
                result = -1
                break
        if result == 0:
            terminal_move = close_values[index + horizon] - entry
            if terminal_move > atr_values[index] * 0.5:
                result = 1
            elif terminal_move < -atr_values[index] * 0.5:
                result = -1
        labels[index] = result
    return pd.Series(labels, index=frame.index, name="label")


@dataclass
class SoftmaxModel:
    mean: np.ndarray
    scale: np.ndarray
    weights: np.ndarray
    classes: np.ndarray

    def predict_proba(self, features: np.ndarray) -> np.ndarray:
        standardized = (features - self.mean) / self.scale
        logits = np.c_[np.ones(len(standardized)), standardized] @ self.weights
        logits -= logits.max(axis=1, keepdims=True)
        exp = np.exp(logits)
        return exp / exp.sum(axis=1, keepdims=True)


def fit_softmax(features: np.ndarray, labels: np.ndarray, l2: float, epochs: int = 700, learning_rate: float = 0.06) -> SoftmaxModel:
    classes = np.array([-1, 0, 1], dtype=int)
    mean = np.nanmean(features, axis=0)
    scale = np.nanstd(features, axis=0)
    scale[scale < 1e-8] = 1
    standardized = np.nan_to_num((features - mean) / scale, nan=0.0, posinf=6.0, neginf=-6.0)
    design = np.c_[np.ones(len(standardized)), standardized]
    targets = np.column_stack([labels == value for value in classes]).astype(float)
    counts = targets.sum(axis=0)
    class_weights = len(labels) / (len(classes) * np.maximum(counts, 1))
    sample_weights = targets @ class_weights
    weights = np.zeros((design.shape[1], len(classes)))
    for epoch in range(epochs):
        logits = design @ weights
        logits -= logits.max(axis=1, keepdims=True)
        probabilities = np.exp(logits)
        probabilities /= probabilities.sum(axis=1, keepdims=True)
        gradient = design.T @ ((probabilities - targets) * sample_weights[:, None]) / len(labels)
        gradient[1:] += l2 * weights[1:] / len(labels)
        weights -= learning_rate / math.sqrt(1 + epoch / 100) * gradient
    return SoftmaxModel(mean, scale, weights, classes)


def macro_f1(actual: np.ndarray, predicted: np.ndarray) -> float:
    scores = []
    for value in (-1, 0, 1):
        true_positive = np.sum((actual == value) & (predicted == value))
        false_positive = np.sum((actual != value) & (predicted == value))
        false_negative = np.sum((actual == value) & (predicted != value))
        precision = true_positive / max(true_positive + false_positive, 1)
        recall = true_positive / max(true_positive + false_negative, 1)
        scores.append(2 * precision * recall / max(precision + recall, 1e-12))
    return float(np.mean(scores))


def score_predictions(actual: np.ndarray, probabilities: np.ndarray, classes: np.ndarray, threshold: float) -> dict[str, float | int]:
    best = probabilities.argmax(axis=1)
    confidence = probabilities.max(axis=1)
    predicted = classes[best]
    predicted = np.where(confidence >= threshold, predicted, 0)
    directional = predicted != 0
    directional_count = int(directional.sum())
    directional_hits = int(np.sum(predicted[directional] == actual[directional]))
    hit_rate = directional_hits / max(directional_count, 1)
    return {
        "accuracy": float(np.mean(predicted == actual)),
        "macro_f1": macro_f1(actual, predicted),
        "directional_signals": directional_count,
        "coverage": directional_count / len(actual),
        "directional_hit_rate": hit_rate,
    }


def train_interval(interval: str) -> dict:
    raw = pd.read_csv(DATA_DIR / f"BTCUSDT_{interval}.csv")
    frame, feature_names = build_features(raw)
    frame["label"] = make_labels(frame)
    usable = frame.dropna(subset=feature_names + ["label"]).iloc[:-HORIZON].copy()
    features = usable[feature_names].to_numpy(float)
    labels = usable["label"].to_numpy(int)
    times = usable["open_time"].to_numpy(np.int64)
    train_end = int(len(usable) * 0.64)
    validation_end = int(len(usable) * 0.80)
    train_x, train_y = features[:train_end], labels[:train_end]
    validation_x, validation_y = features[train_end:validation_end], labels[train_end:validation_end]
    test_x, test_y = features[validation_end:], labels[validation_end:]

    best: tuple[float, float, SoftmaxModel, dict] | None = None
    for l2 in (0.01, 0.1, 1.0, 5.0):
        model = fit_softmax(train_x, train_y, l2=l2)
        validation_probabilities = model.predict_proba(validation_x)
        for threshold in (0.40, 0.45, 0.50, 0.55, 0.60, 0.65):
            metrics = score_predictions(validation_y, validation_probabilities, model.classes, threshold)
            if metrics["directional_signals"] < 50:
                continue
            objective = float(metrics["macro_f1"]) + max(float(metrics["directional_hit_rate"]) - 0.5, 0) * 0.5
            if best is None or objective > best[0]:
                best = (objective, threshold, model, {**metrics, "l2": l2})
    if best is None:
        raise RuntimeError(f"No valid model selected for {interval}")

    _, threshold, _, validation_metrics = best
    selected_l2 = float(validation_metrics["l2"])
    final_model = fit_softmax(features[:validation_end], labels[:validation_end], l2=selected_l2)
    test_probabilities = final_model.predict_proba(test_x)
    test_metrics = score_predictions(test_y, test_probabilities, final_model.classes, threshold)
    baseline = max(np.mean(test_y == value) for value in (-1, 0, 1))

    artifact = {
        "interval": interval,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "data_rows": int(len(usable)),
        "train_rows": int(validation_end),
        "test_rows": int(len(test_y)),
        "train_start": int(times[0]),
        "train_end": int(times[validation_end - 1]),
        "test_start": int(times[validation_end]),
        "test_end": int(times[-1]),
        "feature_names": feature_names,
        "mean": final_model.mean.tolist(),
        "scale": final_model.scale.tolist(),
        "weights": final_model.weights.tolist(),
        "classes": final_model.classes.tolist(),
        "threshold": threshold,
        "l2": selected_l2,
        "label": {"horizon_bars": HORIZON, "barrier_atr": BARRIER_ATR, "entry": "next_bar_open"},
        "validation_metrics": validation_metrics,
        "test_metrics": {**test_metrics, "majority_accuracy": float(baseline)},
        "quality_gate": {
            "sample_outperformance": float(test_metrics["accuracy"]) > float(baseline),
            "minimum_directional_signals": int(test_metrics["directional_signals"]) >= 50,
            "approved_for_display": float(test_metrics["accuracy"]) > float(baseline) and int(test_metrics["directional_signals"]) >= 50,
        },
    }
    (MODEL_DIR / f"model_{interval}.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
    return artifact


def write_reports(artifacts: list[dict]) -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    ledger_path = REPORT_DIR / "calculation-ledger.csv"
    with ledger_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["calculation_id", "interval", "metric", "formula_or_method", "result", "source", "validation_status", "limitations"])
        for artifact in artifacts:
            metrics = artifact["test_metrics"]
            for metric in ("accuracy", "macro_f1", "directional_hit_rate", "coverage", "directional_signals", "majority_accuracy"):
                writer.writerow([
                    f"ml-{artifact['interval']}-{metric}", artifact["interval"], metric,
                    "untouched final 20% time-series test set", metrics[metric], f"Binance Spot BTCUSDT {artifact['interval']}",
                    "verified" if artifact["quality_gate"]["approved_for_display"] else "watch_only",
                    "Spot data; transaction costs and regime shifts may reduce live performance",
                ])
    summary = ["# BTCUSDT形态机器学习样本外报告", "", "标签：当前K线收盘生成信号，下一根开盘入场；未来24根K线先触及±1.5 ATR的一侧为方向标签。", "", "| 周期 | 样本 | 测试集 | 准确率 | 多数类基准 | 方向命中率 | 覆盖率 | 展示许可 |", "|---|---:|---:|---:|---:|---:|---:|---|"]
    for artifact in artifacts:
        metrics = artifact["test_metrics"]
        summary.append(f"| {artifact['interval']} | {artifact['data_rows']} | {artifact['test_rows']} | {metrics['accuracy']:.2%} | {metrics['majority_accuracy']:.2%} | {metrics['directional_hit_rate']:.2%} | {metrics['coverage']:.2%} | {'通过' if artifact['quality_gate']['approved_for_display'] else '仅观察'} |")
    summary.extend(["", "## 限制", "", "- 数据来自Binance Spot，不包含合约资金费率、未平仓量和强平数据。", "- 结果是历史样本外表现，不保证未来成功率。", "- 每个模型采用时间顺序切分；阈值只在验证集选择，最终测试集不参与调参。", "- 当前模型是可解释的正则化Softmax逻辑回归，后续只有在更复杂模型样本外显著改善时才升级。"])
    (REPORT_DIR / "model-report.md").write_text("\n".join(summary), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["download", "train", "all"])
    parser.add_argument("--start", default="2021-01-01")
    parser.add_argument("--intervals", nargs="+", default=list(INTERVAL_MS))
    args = parser.parse_args()
    ensure_dirs()
    if args.command in {"download", "all"}:
        for interval in args.intervals:
            download(interval, args.start)
    if args.command in {"train", "all"}:
        artifacts = [train_interval(interval) for interval in args.intervals]
        write_reports(artifacts)
        for artifact in artifacts:
            print(artifact["interval"], artifact["test_metrics"], artifact["quality_gate"], flush=True)


if __name__ == "__main__":
    main()
