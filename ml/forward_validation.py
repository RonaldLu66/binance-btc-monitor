from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import HORIZON, build_features
from train_event_model import FUTURES_DIR, candidate_events, event_labels
from train_lightgbm import add_derivatives_context, add_higher_timeframe_context, normalize_kline_columns


ROOT = Path(__file__).resolve().parents[1]
STATE_PATH = ROOT / "reports" / "forward-validation.json"
ARTIFACT_PATH = ROOT / "models" / "event_lightgbm_4h.json"
MODEL_PATH = ROOT / "models" / "event_lightgbm_4h.txt"
MIN_SIGNALS = 40


def prepare() -> tuple[pd.DataFrame, list[str]]:
    raw = normalize_kline_columns(pd.read_csv(FUTURES_DIR / "BTCUSDT_4h.csv"))
    frame, names = build_features(raw)
    frame, names = add_higher_timeframe_context("4h", frame, names, FUTURES_DIR)
    frame, names = add_derivatives_context(frame, names, FUTURES_DIR)
    frame = pd.concat([frame, candidate_events(frame)], axis=1)
    frame = pd.concat([frame, event_labels(frame)], axis=1)
    model_features = [*names, "event_side", "event_strength", "long_score", "short_score", "event_type"]
    return frame, model_features


def load_state(artifact: dict) -> dict:
    if STATE_PATH.exists():
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    else:
        state = {}
    state.update({
        "started_at": state.get("started_at", datetime.now(timezone.utc).isoformat()),
        "status": "collecting", "model_cutoff": artifact["evaluation_end"],
        "model_quality_status": artifact["quality_gate"]["status"],
        "requirements": {
            "minimum_resolved_signals": MIN_SIGNALS, "minimum_profit_factor": 1.15,
            "minimum_mean_return": 0.0, "minimum_calendar_days": 30,
        },
        "note": "Frozen watch-only model. Forward results cannot authorize trading without independent review.",
    })
    return state


def generate_signals(frame: pd.DataFrame, features: list[str], artifact: dict) -> list[dict]:
    candidates = frame[(frame["event_side"] != 0) & (frame["open_time"] > artifact["evaluation_end"])].copy()
    candidates = candidates.dropna(subset=features)
    if candidates.empty:
        return []
    booster = lgb.Booster(model_file=str(MODEL_PATH))
    probabilities = booster.predict(candidates[features].replace([np.inf, -np.inf], np.nan).fillna(0).to_numpy(float))
    candidates["probability"] = probabilities
    selected = candidates[candidates["probability"] >= artifact["threshold"]].copy()
    signals: list[dict] = []
    next_available_time = 0
    full_index = {int(value): index for index, value in enumerate(frame["open_time"].to_numpy(np.int64))}
    for _, row in selected.iterrows():
        open_time = int(row["open_time"])
        if open_time < next_available_time:
            continue
        frame_index = full_index[open_time]
        if frame_index + 1 >= len(frame):
            continue
        entry = float(frame.iloc[frame_index + 1]["open"])
        side = int(row["event_side"])
        atr = float(row["atr"])
        target = entry + side * 1.5 * atr
        stop = entry - side * 1.0 * atr
        resolved = pd.notna(row["event_success"])
        ambiguous = bool(row.get("event_ambiguous", False))
        signal = {
            "open_time": open_time, "time": datetime.fromtimestamp(open_time / 1000, timezone.utc).isoformat(),
            "side": "long" if side > 0 else "short", "event_type": int(row["event_type"]),
            "probability": float(row["probability"]), "threshold": float(artifact["threshold"]),
            "entry": entry, "target": target, "stop": stop, "resolved": bool(resolved and not ambiguous),
            "ambiguous": ambiguous, "success": None if not resolved or ambiguous else bool(row["event_success"]),
            "return_after_cost": None if not resolved or ambiguous else float(row["event_return"]),
            "bars_to_exit": None if not resolved or ambiguous else int(row["bars_to_exit"]),
        }
        signals.append(signal)
        next_available_time = open_time + HORIZON * 4 * 60 * 60 * 1000
    return signals


def summarize(state: dict) -> dict:
    resolved = [signal for signal in state["signals"] if signal.get("resolved")]
    returns = [float(signal["return_after_cost"]) for signal in resolved]
    wins = sum(value for value in returns if value > 0)
    losses = -sum(value for value in returns if value < 0)
    cutoff = datetime.fromtimestamp(state["model_cutoff"] / 1000, timezone.utc)
    elapsed = (datetime.now(timezone.utc) - cutoff).days
    summary = {
        "candidate_signals": len(state["signals"]), "resolved_signals": len(resolved),
        "hit_rate": sum(value > 0 for value in returns) / len(returns) if returns else None,
        "mean_return": sum(returns) / len(returns) if returns else None,
        "profit_factor": wins / losses if losses > 0 else None, "calendar_days": elapsed,
    }
    requirements = state["requirements"]
    summary["eligible_for_review"] = (
        len(resolved) >= requirements["minimum_resolved_signals"] and elapsed >= requirements["minimum_calendar_days"]
        and (summary["mean_return"] or 0) > requirements["minimum_mean_return"]
        and (summary["profit_factor"] or 0) >= requirements["minimum_profit_factor"]
    )
    state["summary"] = summary
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    return state


def main() -> None:
    artifact = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
    frame, features = prepare()
    if features != artifact["features"]:
        raise RuntimeError("Feature schema does not match frozen model artifact")
    state = load_state(artifact)
    state["signals"] = generate_signals(frame, features, artifact)
    state = summarize(state)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(state["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
