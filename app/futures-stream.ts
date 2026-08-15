export type FuturesInterval = '15m' | '1h' | '4h' | '1d';

export type FuturesKline = {
  interval: FuturesInterval;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
};

export type FuturesSnapshot = {
  connectedAt: number;
  klines: Record<FuturesInterval, FuturesKline>;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  nextFundingTime: number;
  bid: number;
  ask: number;
};

const intervals: FuturesInterval[] = ['15m', '1h', '4h', '1d'];
const streamUrl = 'wss://fstream.binancefuture.com/stream?streams=btcusdt@kline_15m/btcusdt@kline_1h/btcusdt@kline_4h/btcusdt@kline_1d/btcusdt@markPrice@1s/btcusdt@bookTicker';

type Cache = { value: FuturesSnapshot | null; expiresAt: number; pending: Promise<FuturesSnapshot> | null };
const globalCache = globalThis as typeof globalThis & { __btcFuturesSnapshot?: Cache };
const cache = globalCache.__btcFuturesSnapshot ?? { value: null, expiresAt: 0, pending: null };
globalCache.__btcFuturesSnapshot = cache;

function connect() {
  return new Promise<FuturesSnapshot>((resolve, reject) => {
    const klines: Partial<Record<FuturesInterval, FuturesKline>> = {};
    let markPrice: number | null = null;
    let indexPrice: number | null = null;
    let fundingRate: number | null = null;
    let nextFundingTime: number | null = null;
    let bid: number | null = null;
    let ask: number | null = null;
    let settled = false;
    const socket = new WebSocket(streamUrl);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) {
        reject(error);
        return;
      }
      resolve({
        connectedAt: Date.now(), klines: klines as Record<FuturesInterval, FuturesKline>,
        markPrice: markPrice!, indexPrice: indexPrice!, fundingRate: fundingRate!,
        nextFundingTime: nextFundingTime!, bid: bid!, ask: ask!,
      });
    };
    const ready = () => intervals.every((interval) => klines[interval])
      && markPrice !== null && indexPrice !== null && fundingRate !== null
      && nextFundingTime !== null && bid !== null && ask !== null;
    const timer = setTimeout(() => finish(new Error('Binance Futures WebSocket timeout')), 12000);
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const data = message.data ?? message;
      if (data.k && intervals.includes(data.k.i as FuturesInterval)) {
        const interval = data.k.i as FuturesInterval;
        klines[interval] = {
          interval, openTime: Number(data.k.t), closeTime: Number(data.k.T),
          open: Number(data.k.o), high: Number(data.k.h), low: Number(data.k.l), close: Number(data.k.c),
          volume: Number(data.k.v), closed: Boolean(data.k.x),
        };
      } else if (data.e === 'markPriceUpdate') {
        markPrice = Number(data.p);
        indexPrice = Number(data.i);
        fundingRate = Number(data.r);
        nextFundingTime = Number(data.T);
      } else if (data.e === 'bookTicker') {
        bid = Number(data.b);
        ask = Number(data.a);
      }
      if (ready()) finish();
    };
    socket.onerror = () => finish(new Error('Binance Futures WebSocket unavailable'));
  });
}

export async function getFuturesSnapshot() {
  if (cache.value && cache.expiresAt > Date.now()) return cache.value;
  if (cache.pending) return cache.pending;
  cache.pending = connect().then((snapshot) => {
    cache.value = snapshot;
    cache.expiresAt = Date.now() + 2500;
    return snapshot;
  }).finally(() => {
    cache.pending = null;
  });
  return cache.pending;
}
