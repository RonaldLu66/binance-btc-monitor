from __future__ import annotations

import argparse
import io
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "futures"
KLINE_COLUMNS = ["open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume", "count", "taker_buy_volume", "taker_buy_quote_volume", "ignore"]


def download_bytes(url: str, retries: int = 4) -> bytes | None:
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "btc-pattern-ml/1.0"})
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
        except Exception:
            pass
        time.sleep(1.0 + attempt)
    return None


def frame_from_zip(payload: bytes) -> pd.DataFrame:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        filename = archive.namelist()[0]
        with archive.open(filename) as handle:
            content = handle.read()
    first_token = content.split(b",", 1)[0].strip().lower()
    if first_token.isdigit():
        return pd.read_csv(io.BytesIO(content), header=None, names=KLINE_COLUMNS)
    return pd.read_csv(io.BytesIO(content))


def months(start: str, end: date) -> list[str]:
    current = datetime.fromisoformat(start).date().replace(day=1)
    output = []
    while current <= end.replace(day=1):
        output.append(current.strftime("%Y-%m"))
        current = (current.replace(day=28) + timedelta(days=4)).replace(day=1)
    return output


def days(start: str, end: date) -> list[str]:
    current = datetime.fromisoformat(start).date()
    output = []
    while current <= end:
        output.append(current.isoformat())
        current += timedelta(days=1)
    return output


def fetch_frame(url: str, key: str) -> tuple[str, pd.DataFrame | None]:
    payload = download_bytes(url)
    return key, None if payload is None else frame_from_zip(payload)


def download_monthly(kind: str, interval: str | None, start: str, end: date) -> pd.DataFrame:
    tasks = []
    for month in months(start, end):
        if kind == "klines":
            url = f"https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/{interval}/BTCUSDT-{interval}-{month}.zip"
        else:
            url = f"https://data.binance.vision/data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-{month}.zip"
        tasks.append((url, month))
    frames = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(fetch_frame, url, key) for url, key in tasks]
        for future in as_completed(futures):
            key, frame = future.result()
            if frame is not None:
                frames.append(frame)
            print(kind, interval or "", key, "ok" if frame is not None else "missing", flush=True)
    if not frames:
        raise RuntimeError(f"No {kind} data")
    return pd.concat(frames, ignore_index=True)


def download_metrics(start: str, end: date) -> pd.DataFrame:
    tasks = []
    for day in days(start, end):
        url = f"https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-{day}.zip"
        tasks.append((url, day))
    frames = []
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(fetch_frame, url, key) for url, key in tasks]
        for index, future in enumerate(as_completed(futures), start=1):
            key, frame = future.result()
            if frame is not None:
                frames.append(frame)
            if index % 50 == 0 or index == len(futures):
                print("metrics", index, "/", len(futures), key, flush=True)
    if not frames:
        raise RuntimeError("No metrics data")
    return pd.concat(frames, ignore_index=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2021-01-01")
    parser.add_argument("--intervals", nargs="+", default=["4h", "1d"])
    args = parser.parse_args()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).date()
    for interval in args.intervals:
        output = DATA_DIR / f"BTCUSDT_{interval}.csv"
        frame = download_monthly("klines", interval, args.start, today)
        if list(frame.columns) != KLINE_COLUMNS:
            raise RuntimeError(f"Unexpected kline columns for {interval}: {list(frame.columns)}")
        frame = frame.drop_duplicates("open_time").sort_values("open_time")
        frame.to_csv(output, index=False)
        print(output, len(frame), flush=True)
    funding = download_monthly("funding", None, args.start, today)
    funding = funding.drop_duplicates("calc_time").sort_values("calc_time")
    funding.to_csv(DATA_DIR / "BTCUSDT_funding.csv", index=False)
    metrics = download_metrics(args.start, today)
    metrics["create_time"] = pd.to_datetime(metrics["create_time"], utc=True)
    metrics = metrics.drop_duplicates("create_time").sort_values("create_time")
    metrics.to_csv(DATA_DIR / "BTCUSDT_metrics_5m.csv", index=False)
    print("funding", len(funding), "metrics", len(metrics), flush=True)


if __name__ == "__main__":
    main()
