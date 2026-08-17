export type BinanceFuturesInterval = '15m' | '1h' | '4h' | '1d';

export type BinanceFuturesRawKline = [
  number, string, string, string, string, string, number, ...unknown[],
];

type IntervalCache = {
  rows: BinanceFuturesRawKline[] | null;
  source: string;
  expiresAt: number;
  pending: Promise<{ rows: BinanceFuturesRawKline[]; source: string }> | null;
};

const endpointCandidates = [
  { base: 'https://fapi.binance.com', label: 'Binance USDⓈ-M Futures REST' },
  { base: 'https://www.binance.com', label: 'Binance USDⓈ-M Futures REST（备用域名）' },
];

const globalCache = globalThis as typeof globalThis & {
  __btcBinanceFuturesHistory?: Partial<Record<BinanceFuturesInterval, IntervalCache>>;
};
const caches = globalCache.__btcBinanceFuturesHistory ?? {};
globalCache.__btcBinanceFuturesHistory = caches;

function requestJson(url: string) {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? (process.env.VERCEL ? undefined : 'http://127.0.0.1:7890');
  if (!proxy) return fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(6000) }).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
  return new Promise<unknown>((resolve, reject) => {
    const request = https.get(url, { agent: new HttpsProxyAgent(proxy), headers: { Accept: 'application/json' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(`HTTP ${response.statusCode ?? 500}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('Request timeout')));
    request.on('error', reject);
  });
}

function cacheFor(interval: BinanceFuturesInterval) {
  if (!caches[interval]) {
    caches[interval] = { rows: null, source: '', expiresAt: 0, pending: null };
  }
  return caches[interval]!;
}

async function requestKlines(interval: BinanceFuturesInterval, limit: number) {
  const failures: string[] = [];
  for (const endpoint of endpointCandidates) {
    const url = `${endpoint.base}/fapi/v1/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
    try {
      const rows = await requestJson(url) as BinanceFuturesRawKline[];
      if (rows.length < Math.min(100, limit) || !Array.isArray(rows[0])) {
        failures.push(`${endpoint.base}: invalid payload`);
        continue;
      }
      return { rows, source: endpoint.label };
    } catch (error) {
      failures.push(`${endpoint.base}: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }
  throw new Error(`Binance futures ${interval} history unavailable (${failures.join('; ')})`);
}

export async function getBinanceFuturesKlines(interval: BinanceFuturesInterval, limit = 300) {
  const cache = cacheFor(interval);
  if (cache.rows && cache.expiresAt > Date.now() && cache.rows.length >= limit) {
    return { rows: cache.rows.slice(-limit), source: cache.source };
  }
  if (cache.pending) return cache.pending;
  cache.pending = requestKlines(interval, Math.max(100, Math.min(limit, 500))).then((result) => {
    cache.rows = result.rows;
    cache.source = result.source;
    cache.expiresAt = Date.now() + 10_000;
    return result;
  }).finally(() => {
    cache.pending = null;
  });
  return cache.pending;
}

export async function getBinanceFuturesHistory(intervals: BinanceFuturesInterval[]) {
  const results = await Promise.all(intervals.map(async (interval) => [
    interval,
    await getBinanceFuturesKlines(interval, 300),
  ] as const));
  return {
    rows: results.map(([interval, result]) => [interval, result.rows] as const),
    source: [...new Set(results.map(([, result]) => result.source))].join(' + '),
  };
}

export async function getBinanceFuturesQuote() {
  const failures: string[] = [];
  for (const endpoint of endpointCandidates) {
    try {
      const [ticker, premium, book] = await Promise.all([
        requestJson(`${endpoint.base}/fapi/v1/ticker/price?symbol=BTCUSDT`) as Promise<{ price: string; time: number }>,
        requestJson(`${endpoint.base}/fapi/v1/premiumIndex?symbol=BTCUSDT`) as Promise<{
          markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number; time: number;
        }>,
        requestJson(`${endpoint.base}/fapi/v1/ticker/bookTicker?symbol=BTCUSDT`) as Promise<{
          bidPrice: string; askPrice: string; time: number;
        }>,
      ]);
      return {
        connectedAt: Date.now(),
        lastPrice: Number(ticker.price), lastTradeTime: Number(ticker.time),
        markPrice: Number(premium.markPrice), indexPrice: Number(premium.indexPrice),
        fundingRate: Number(premium.lastFundingRate), nextFundingTime: Number(premium.nextFundingTime),
        bid: Number(book.bidPrice), ask: Number(book.askPrice), source: `${endpoint.label}（3秒轮询）`,
      };
    } catch (error) {
      failures.push(`${endpoint.base}: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }
  throw new Error(`Binance futures quote unavailable (${failures.join('; ')})`);
}
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
