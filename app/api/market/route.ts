import { NextResponse } from 'next/server';
import { getFuturesSnapshot, type FuturesInterval } from '../../futures-stream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const source = {
  label: 'Binance Spot (futures endpoint unavailable)',
  market: 'spot',
  url: 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120',
} as const;

const allowedIntervals = new Set(['15m', '1h', '4h', '1d']);

export async function GET(request: Request) {
  const requestedInterval = new URL(request.url).searchParams.get('interval') ?? '15m';
  const interval = allowedIntervals.has(requestedInterval) ? requestedInterval : '15m';
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=300`;
  try {
    const [response, futures] = await Promise.all([
      fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) }),
      getFuturesSnapshot().catch(() => null),
    ]);
    if (response.ok) {
      const rows = await response.json() as unknown[][];
      const futuresKline = futures?.klines[interval as FuturesInterval];
      if (futuresKline) {
        const liveRow = [
          futuresKline.openTime, String(futuresKline.open), String(futuresKline.high),
          String(futuresKline.low), String(futuresKline.close), String(futuresKline.volume),
          futuresKline.closeTime, '0', 0, '0', '0', '0',
        ];
        if (Number(rows.at(-1)?.[0]) === futuresKline.openTime) rows[rows.length - 1] = liveRow;
        else rows.push(liveRow);
      }
      return NextResponse.json(
        {
          rows,
          source: futures ? 'Binance USDⓈ-M Futures WebSocket（实时）+ Spot（历史补足）' : source.label,
          market: futures ? 'futures' : source.market,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
  } catch {
    return NextResponse.json({ error: 'Unable to reach Binance public market data' }, { status: 502 });
  }
  return NextResponse.json({ error: 'Unable to reach Binance public market data' }, { status: 502 });
}
