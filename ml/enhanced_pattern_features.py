from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from pipeline import build_features
from train_lightgbm import normalize_kline_columns


RULE_COLUMNS = {
    "confirmed_breakout_up": 1,
    "confirmed_breakdown": -1,
    "breakout_retest_hold": 1,
    "breakdown_retest_reject": -1,
    "second_breakout_up": 1,
    "second_breakdown": -1,
    "head_shoulders_bottom_confirmed": 1,
    "head_shoulders_top_confirmed": -1,
    "spring_break_low": 1,
    "false_breakout_up": -1,
}


def _recent_level(level: pd.Series, event: pd.Series, lookback: int) -> pd.Series:
    values = level.where(event.astype(bool)).shift(1)
    return values.ffill(limit=lookback)


def add_principle_features(frame: pd.DataFrame, feature_names: list[str]) -> tuple[pd.DataFrame, list[str]]:
    enriched = frame.copy()
    names = list(feature_names)
    open_price = pd.to_numeric(enriched["open"], errors="coerce")
    high = pd.to_numeric(enriched["high"], errors="coerce")
    low = pd.to_numeric(enriched["low"], errors="coerce")
    close = pd.to_numeric(enriched["close"], errors="coerce")
    volume = pd.to_numeric(enriched["volume"], errors="coerce")
    atr = pd.to_numeric(enriched["atr"], errors="coerce")

    def add(name: str, values: pd.Series) -> None:
        enriched[name] = values.replace([np.inf, -np.inf], np.nan)
        names.append(name)

    resistance = high.shift(1).rolling(20).max()
    support = low.shift(1).rolling(20).min()
    volume_mean_20 = volume.shift(1).rolling(20).mean()
    raw_breakout_up = close > resistance
    raw_breakdown = close < support
    breakout_volume_ratio = volume / volume_mean_20.replace(0, np.nan)
    confirmed_breakout_up = raw_breakout_up & (breakout_volume_ratio >= 1.2)
    confirmed_breakdown = raw_breakdown & (breakout_volume_ratio >= 1.2)

    recent_up_level = _recent_level(resistance, confirmed_breakout_up, 6)
    recent_down_level = _recent_level(support, confirmed_breakdown, 6)
    retest_tolerance = 0.25 * atr
    breakout_retest_hold = (
        recent_up_level.notna()
        & (low <= recent_up_level + retest_tolerance)
        & (low >= recent_up_level - retest_tolerance)
        & (close > recent_up_level)
    )
    breakdown_retest_reject = (
        recent_down_level.notna()
        & (high >= recent_down_level - retest_tolerance)
        & (high <= recent_down_level + retest_tolerance)
        & (close < recent_down_level)
    )

    prior_up_break = raw_breakout_up.shift(8).rolling(33).max().fillna(0).astype(bool)
    prior_down_break = raw_breakdown.shift(8).rolling(33).max().fillna(0).astype(bool)
    second_breakout_up = confirmed_breakout_up & prior_up_break
    second_breakdown = confirmed_breakdown & prior_down_break

    prior_head_shoulders_bottom = enriched["head_shoulders_bottom"].shift(1).rolling(36).max().fillna(0) > 0
    prior_head_shoulders_top = enriched["head_shoulders_top"].shift(1).rolling(36).max().fillna(0) > 0
    head_shoulders_bottom_confirmed = prior_head_shoulders_bottom & confirmed_breakout_up
    head_shoulders_top_confirmed = prior_head_shoulders_top & confirmed_breakdown

    short_volume = volume.rolling(5).mean()
    long_volume = volume.shift(5).rolling(20).mean()
    short_range = (high.rolling(5).max() - low.rolling(5).min()) / atr.replace(0, np.nan)
    long_range = (high.shift(5).rolling(20).max() - low.shift(5).rolling(20).min()) / atr.replace(0, np.nan)
    terminal_volume_contraction = (short_volume < long_volume * 0.75) & (short_range < long_range * 0.6)

    leg_bars = 14
    first_leg = np.log(close.shift(leg_bars) / close.shift(leg_bars * 2))
    second_leg = np.log(close / close.shift(leg_bars))
    symmetry_score = 1 - (first_leg.abs() - second_leg.abs()).abs() / (first_leg.abs() + second_leg.abs()).replace(0, np.nan)
    symmetric_reversal = (np.sign(first_leg) != np.sign(second_leg)) & (symmetry_score >= 0.7)

    large_bearish_candle = (open_price - close) >= 1.25 * atr
    last_large_bear_high = high.where(large_bearish_candle).ffill(limit=12)
    long_structure_level = pd.concat([recent_up_level, support], axis=1).max(axis=1)
    long_stop_distance = (close - long_structure_level) / close
    short_stop_distance = (last_large_bear_high - close) / close

    prior_low_40 = low.shift(1).rolling(40).min()
    prior_high_40 = high.shift(1).rolling(40).max()
    prior_range = (prior_high_40 - prior_low_40).replace(0, np.nan)
    measured_move_up_ratio = (close - prior_high_40) / prior_range
    measured_move_down_ratio = (prior_low_40 - close) / prior_range

    add("raw_breakout_up", raw_breakout_up.astype(float))
    add("raw_breakdown", raw_breakdown.astype(float))
    add("breakout_volume_ratio", breakout_volume_ratio)
    add("confirmed_breakout_up", confirmed_breakout_up.astype(float))
    add("confirmed_breakdown", confirmed_breakdown.astype(float))
    add("breakout_retest_hold", breakout_retest_hold.astype(float))
    add("breakdown_retest_reject", breakdown_retest_reject.astype(float))
    add("breakout_retest_depth_atr", (low - recent_up_level) / atr)
    add("breakdown_retest_depth_atr", (high - recent_down_level) / atr)
    add("second_breakout_up", second_breakout_up.astype(float))
    add("second_breakdown", second_breakdown.astype(float))
    add("head_shoulders_bottom_confirmed", head_shoulders_bottom_confirmed.astype(float))
    add("head_shoulders_top_confirmed", head_shoulders_top_confirmed.astype(float))
    add("terminal_volume_contraction", terminal_volume_contraction.astype(float))
    add("terminal_volume_ratio", short_volume / long_volume.replace(0, np.nan))
    add("time_symmetry_14", symmetry_score.clip(lower=-1, upper=1))
    add("time_symmetric_reversal_up", (symmetric_reversal & (second_leg > 0)).astype(float))
    add("time_symmetric_reversal_down", (symmetric_reversal & (second_leg < 0)).astype(float))
    add("large_bearish_candle", large_bearish_candle.astype(float))
    add("long_structure_stop_pct", long_stop_distance)
    add("short_structure_stop_pct", short_stop_distance)
    add("leverage_long_stop_feasible", long_stop_distance.between(0.005, 0.03).astype(float))
    add("leverage_short_stop_feasible", short_stop_distance.between(0.005, 0.03).astype(float))
    add("measured_move_up_ratio", measured_move_up_ratio)
    add("measured_move_down_ratio", measured_move_down_ratio)
    add("measured_move_up_satisfied", (measured_move_up_ratio >= 1).astype(float))
    add("measured_move_down_satisfied", (measured_move_down_ratio >= 1).astype(float))
    return enriched, names


def add_weekly_context(
    frame: pd.DataFrame,
    feature_names: list[str],
    data_directory: Path,
) -> tuple[pd.DataFrame, list[str]]:
    daily_path = data_directory / "BTCUSDT_1d.csv"
    if not daily_path.exists():
        return frame, feature_names
    daily = normalize_kline_columns(pd.read_csv(daily_path))
    for column in ("open", "high", "low", "close", "volume", "quote_volume", "trades", "taker_base", "taker_quote"):
        if column in daily:
            daily[column] = pd.to_numeric(daily[column], errors="coerce")
    daily["date"] = pd.to_datetime(daily["open_time"], unit="ms", utc=True)
    daily["week"] = daily["date"].dt.tz_localize(None).dt.to_period("W-SUN")
    aggregations = {
        "open_time": "first", "open": "first", "high": "max", "low": "min", "close": "last",
        "volume": "sum", "close_time": "last", "quote_volume": "sum", "trades": "sum",
        "taker_base": "sum", "taker_quote": "sum", "ignore": "last",
    }
    available = {column: method for column, method in aggregations.items() if column in daily.columns}
    weekly = daily.groupby("week", sort=True).agg(available)
    weekly["day_count"] = daily.groupby("week").size()
    weekly = weekly[weekly["day_count"] == 7].reset_index(drop=True)
    for column in ("open", "high", "low", "close", "volume", "quote_volume", "trades", "taker_base", "taker_quote"):
        if column in weekly:
            weekly[column] = pd.to_numeric(weekly[column], errors="coerce")
    weekly_frame, weekly_names = build_features(weekly)
    selected = [
        name for name in (
            "return_3", "return_6", "ema_gap_20", "ema_gap_50", "ema_20_50",
            "macd_atr", "macd_hist_atr", "macd_hist_delta", "macd_above_zero",
            "macd_gold_cross", "macd_death_cross", "rsi_14", "relative_volume",
            "range_position_20", "range_contraction", "breakout_up_20", "breakout_down_20",
        ) if name in weekly_names
    ]
    weekly_frame["close_time"] = pd.to_numeric(weekly_frame["close_time"], errors="coerce")
    rename = {name: f"ctx_1w_{name}" for name in selected}
    context = weekly_frame[["close_time", *selected]].rename(columns=rename).sort_values("close_time")
    enriched = frame.copy().sort_values("close_time")
    enriched["close_time"] = pd.to_numeric(enriched["close_time"], errors="coerce")
    enriched = pd.merge_asof(enriched, context, on="close_time", direction="backward", allow_exact_matches=True)
    return enriched.sort_values("open_time").reset_index(drop=True), [*feature_names, *rename.values()]


def strict_candidate_events(frame: pd.DataFrame, enabled_rules: set[str]) -> pd.DataFrame:
    def enabled(name: str) -> pd.Series:
        if name not in enabled_rules:
            return pd.Series(0.0, index=frame.index)
        return frame[name].fillna(0).astype(float)

    long_price = (
        1.5 * enabled("spring_break_low")
        + 1.2 * enabled("confirmed_breakout_up")
        + 1.5 * enabled("breakout_retest_hold")
        + 1.3 * enabled("second_breakout_up")
        + 1.6 * enabled("head_shoulders_bottom_confirmed")
    )
    short_price = (
        1.5 * enabled("false_breakout_up")
        + 1.2 * enabled("confirmed_breakdown")
        + 1.5 * enabled("breakdown_retest_reject")
        + 1.3 * enabled("second_breakdown")
        + 1.6 * enabled("head_shoulders_top_confirmed")
    )
    long_context = (
        0.35 * frame["macd_gold_cross"] + 0.45 * frame["macd_bull_divergence"]
        + 0.30 * frame["rsi_bull_divergence"] + 0.20 * frame["terminal_volume_contraction"]
        + 0.20 * (frame.get("ctx_1w_ema_20_50", 0) > 0).astype(float)
    )
    short_context = (
        0.35 * frame["macd_death_cross"] + 0.45 * frame["macd_bear_divergence"]
        + 0.30 * frame["rsi_bear_divergence"] + 0.20 * frame["terminal_volume_contraction"]
        + 0.20 * (frame.get("ctx_1w_ema_20_50", 0) < 0).astype(float)
    )
    long_score = long_price + long_context
    short_score = short_price + short_context
    has_long_trigger = long_price > 0
    has_short_trigger = short_price > 0
    side = np.where(
        has_long_trigger & (~has_short_trigger | (long_score > short_score)), 1,
        np.where(has_short_trigger & (~has_long_trigger | (short_score > long_score)), -1, 0),
    )
    event_strength = np.where(side > 0, long_score, np.where(side < 0, short_score, 0))
    ordered = list(RULE_COLUMNS)
    event_type = np.select(
        [enabled(name) > 0 for name in ordered],
        [101 + index for index in range(len(ordered))],
        default=0,
    )
    return pd.DataFrame(
        {
            "event_side": side,
            "event_strength": event_strength,
            "long_score": long_score,
            "short_score": short_score,
            "event_type": event_type,
        },
        index=frame.index,
    )


def augment_candidate_events(base: pd.DataFrame, frame: pd.DataFrame, enabled_rules: set[str]) -> pd.DataFrame:
    augmented = base.copy()
    long_addition = pd.Series(0.0, index=frame.index)
    short_addition = pd.Series(0.0, index=frame.index)
    weights = {
        "confirmed_breakout_up": 1.2,
        "confirmed_breakdown": 1.2,
        "breakout_retest_hold": 1.5,
        "breakdown_retest_reject": 1.5,
        "second_breakout_up": 1.3,
        "second_breakdown": 1.3,
        "head_shoulders_bottom_confirmed": 1.6,
        "head_shoulders_top_confirmed": 1.6,
        "spring_break_low": 1.5,
        "false_breakout_up": 1.5,
    }
    for rule in enabled_rules:
        if rule not in RULE_COLUMNS:
            continue
        contribution = frame[rule].fillna(0).astype(float) * weights[rule]
        if RULE_COLUMNS[rule] > 0:
            long_addition += contribution
        else:
            short_addition += contribution
    augmented["long_score"] = augmented["long_score"] + long_addition
    augmented["short_score"] = augmented["short_score"] + short_addition
    augmented["event_strength"] = np.maximum(augmented["long_score"], augmented["short_score"])
    augmented["event_side"] = np.where(
        augmented["long_score"] > augmented["short_score"], 1,
        np.where(augmented["short_score"] > augmented["long_score"], -1, 0),
    )
    base_has_event = base["event_side"] != 0
    ordered = [rule for rule in RULE_COLUMNS if rule in enabled_rules]
    if ordered:
        new_type = np.select(
            [frame[rule].fillna(0) > 0 for rule in ordered],
            [101 + list(RULE_COLUMNS).index(rule) for rule in ordered],
            default=0,
        )
        augmented["event_type"] = np.where(base_has_event, base["event_type"], new_type)
    return augmented
