from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from enhanced_pattern_features import RULE_COLUMNS, add_principle_features, add_weekly_context
from pipeline import HORIZON, build_features
from train_event_model import FUTURES_DIR, event_labels, nonoverlap_metrics
from train_lightgbm import add_derivatives_context, add_higher_timeframe_context, normalize_kline_columns


ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = ROOT / "reports" / "principle-rule-audit.json"
SELECTION_END = int(datetime(2024, 8, 1, tzinfo=timezone.utc).timestamp() * 1000)


def prepare() -> pd.DataFrame:
    raw = normalize_kline_columns(pd.read_csv(FUTURES_DIR / "BTCUSDT_4h.csv"))
    frame, names = build_features(raw)
    frame, names = add_principle_features(frame, names)
    frame, names = add_higher_timeframe_context("4h", frame, names, FUTURES_DIR)
    frame, names = add_weekly_context(frame, names, FUTURES_DIR)
    frame, _ = add_derivatives_context(frame, names, FUTURES_DIR)
    return frame


def summarize_rule(frame: pd.DataFrame, rule: str, side: int) -> dict:
    event_frame = frame.copy()
    event_frame["event_side"] = np.where(event_frame[rule].fillna(0) > 0, side, 0)
    labelled = pd.concat([event_frame, event_labels(event_frame)], axis=1)
    usable = labelled[
        (labelled["event_side"] != 0)
        & (labelled["open_time"] < SELECTION_END)
    ].dropna(subset=["event_success", "event_return", "bars_to_exit"]).iloc[:-HORIZON]
    if usable.empty:
        metrics = nonoverlap_metrics(np.array([]), np.array([]), np.array([]), np.array([]), 0.5)
    else:
        metrics = nonoverlap_metrics(
            np.ones(len(usable)),
            usable["event_success"].to_numpy(int),
            usable["event_return"].to_numpy(float),
            usable["bars_to_exit"].to_numpy(float),
            0.5,
        )
    yearly = []
    usable = usable.copy()
    usable["year"] = pd.to_datetime(usable["open_time"], unit="ms", utc=True).dt.year
    for year, group in usable.groupby("year"):
        year_metrics = nonoverlap_metrics(
            np.ones(len(group)), group["event_success"].to_numpy(int), group["event_return"].to_numpy(float),
            group["bars_to_exit"].to_numpy(float), 0.5,
        )
        yearly.append({"year": int(year), **year_metrics})
    eligible_years = [item for item in yearly if item["signals"] >= 5]
    positive_years = sum(item["mean_return"] > 0 for item in eligible_years)
    stable = (
        metrics["signals"] >= 20
        and metrics["mean_return"] > 0
        and metrics["profit_factor"] >= 1.05
        and len(eligible_years) >= 2
        and positive_years / len(eligible_years) >= 0.60
        and min(item["mean_return"] for item in eligible_years) > -0.006
    )
    return {
        "rule": rule, "side": side, "raw_events": int(len(usable)), **metrics,
        "yearly": yearly, "positive_eligible_years": positive_years,
        "eligible_years": len(eligible_years), "selected": bool(stable),
    }


def run() -> dict:
    frame = prepare()
    rules = [summarize_rule(frame, rule, side) for rule, side in RULE_COLUMNS.items()]
    selected = [item["rule"] for item in rules if item["selected"]]
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "selection_end_exclusive": SELECTION_END,
        "target": {"target_atr": 1.5, "stop_atr": 1.0, "horizon_bars": HORIZON, "round_trip_cost": 0.0008},
        "selection_rule": {
            "minimum_nonoverlap_signals": 20, "minimum_profit_factor": 1.05,
            "minimum_mean_return": 0.0, "minimum_eligible_years": 2,
            "minimum_positive_year_share": 0.60, "worst_year_mean_return_floor": -0.006,
        },
        "selected_rules": selected,
        "rules": rules,
        "note": "Rule selection uses only data before the frozen baseline evaluation period. Unselected rules remain features for research but cannot create candidate entries.",
    }
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"selected_rules": selected, "rules": [{key: item[key] for key in ("rule", "signals", "hit_rate", "mean_return", "profit_factor", "selected")} for item in rules]}, ensure_ascii=False, indent=2))
    return report


if __name__ == "__main__":
    run()
