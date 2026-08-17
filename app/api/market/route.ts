import { NextResponse } from 'next/server';
import { getFuturesSnapshot, type FuturesInterval } from '../../futures-stream';
import { getBinanceFuturesKlines, getBinanceFuturesQuote } from '../../binance-futures-history';
import { getTradingViewHistory } from '../../tradingview-history';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 20;

const allowedIntervals = new Set(['15m', '1h', '4h', '1d']);

export async function GET(request: Request) {
  const requestedInterval = new URL(request.url).searchParams.get('interval') ?? '15m';
  const interval = allowedIntervals.has(requestedInterval) ? requestedInterval : '15m';
  try {
    const [history, futures] = await Promise.all([
      getBinanceFuturesKlines(interval as FuturesInterval, 300).catch(async () => {
        const fallback = await getTradingViewHistory();
        return { rows: fallback[interval as FuturesInterval], source: 'TradingView · BINANCE:BTCUSDT.P 永续合约K线（灾备）' };
      }),
      Promise.any([getFuturesSnapshot(), getBinanceFuturesQuote()]).catch(() => null),
    ]);
    const rows = [...history.rows] as unknown[][];
    const futuresKline = futures && 'klines' in futures ? futures.klines[interval as FuturesInterval] : undefined;
    if (futuresKline) {
      const liveRow = [
        futuresKline.openTime, String(futuresKline.open), String(futuresKline.high),
        String(futuresKline.low), String(futuresKline.close), String(futuresKline.volume),
        futuresKline.closeTime, '0', 0, '0', '0', '0',
      ];
      if (Number(rows.at(-1)?.[0]) === futuresKline.openTime) rows[rows.length - 1] = liveRow;
      else rows.push(liveRow);
    } else if (futures && 'source' in futures && rows.length) {
      const index = rows.length - 1;
      const current = rows[index];
      const lastPrice = futures.lastPrice;
      rows[index] = [
        current[0], current[1], String(Math.max(Number(current[2]), lastPrice)),
        String(Math.min(Number(current[3]), lastPrice)), String(lastPrice), current[5], ...current.slice(6),
      ];
    }
    return NextResponse.json(
      {
        rows,
        source: `${history.source}${futures ? ` + ${'source' in futures ? futures.source : 'Binance Futures WebSocket（实时K线）'}` : ''}`,
        market: 'futures',
        lastPrice: futures?.lastPrice ?? Number(rows.at(-1)?.[4]),
        markPrice: futures?.markPrice,
        serverTime: Date.now(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: 'Unable to reach Binance public market data' }, { status: 502 });
  }
  return NextResponse.json({ error: 'Unable to reach Binance public market data' }, { status: 502 });
}
