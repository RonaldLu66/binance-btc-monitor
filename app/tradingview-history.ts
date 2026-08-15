import WebSocket, { type RawData } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

export type HistoryInterval = '15m' | '1h' | '4h' | '1d';
export type HistoryKline = [number, string, string, string, string, string, number];

const intervals: HistoryInterval[] = ['15m', '1h', '4h', '1d'];
const resolutions: Record<HistoryInterval, string> = { '15m': '15', '1h': '60', '4h': '240', '1d': '1D' };
const durationMs: Record<HistoryInterval, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

type History = Record<HistoryInterval, HistoryKline[]>;
type Cache = { value: History | null; expiresAt: number; pending: Promise<History> | null };
const globalCache = globalThis as typeof globalThis & { __btcTradingViewHistory?: Cache };
const cache = globalCache.__btcTradingViewHistory ?? { value: null, expiresAt: 0, pending: null };
globalCache.__btcTradingViewHistory = cache;

function protocolFrame(method: string, params: unknown[]) {
  const payload = JSON.stringify({ m: method, p: params });
  return `~m~${Buffer.byteLength(payload)}~m~${payload}`;
}

function connectInterval(interval: HistoryInterval) {
  return new Promise<HistoryKline[]>((resolve, reject) => {
    const proxy = process.env.TRADINGVIEW_PROXY ?? process.env.HTTPS_PROXY ?? 'http://127.0.0.1:7890';
    const socket = new WebSocket('wss://data.tradingview.com/socket.io/websocket?from=chart%2FBTCUSDT', {
      headers: { Origin: 'https://www.tradingview.com' },
      agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
    });
    const chartSession = `cs_${Math.random().toString(36).slice(2, 14)}`;
    let settled = false;

    const finish = (bars?: HistoryKline[], error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(bars ?? []);
    };
    const timer = setTimeout(() => finish(undefined, new Error(`TradingView ${interval} history timeout`)), 15_000);
    const send = (method: string, params: unknown[]) => socket.send(protocolFrame(method, params));

    socket.on('open', () => {
      send('set_auth_token', ['unauthorized_user_token']);
      send('chart_create_session', [chartSession, '']);
      send('switch_timezone', [chartSession, 'Etc/UTC']);
      send('resolve_symbol', [chartSession, 'symbol_1', '={"adjustment":"splits","session":"regular","symbol":"BINANCE:BTCUSDT.P"}']);
      send('create_series', [chartSession, 's1', 's1', 'symbol_1', resolutions[interval], 300, '']);
    });

    socket.on('message', (chunk: RawData) => {
      const text = String(chunk);
      for (const payload of text.split(/~m~\d+~m~/).filter(Boolean)) {
        if (payload.startsWith('~h~')) {
          socket.send(`~m~${Buffer.byteLength(payload)}~m~${payload}`);
          continue;
        }
        try {
          const message = JSON.parse(payload) as { m?: string; p?: unknown[] };
          if (message.m === 'critical_error' || message.m === 'series_error') {
            finish(undefined, new Error(`TradingView ${interval} ${message.m}: ${JSON.stringify(message.p ?? [])}`));
            return;
          }
          if (message.m !== 'timescale_update') continue;
          const updates = message.p?.[1] as Record<string, { s?: Array<{ v?: unknown[] }> }> | undefined;
          const entries = updates?.s1?.s;
          if (!entries?.length) continue;
          const rawBars = entries.map((entry) => entry.v).filter((values): values is [number, number, number, number, number, number] =>
            Array.isArray(values) && values.length >= 6 && values.slice(0, 6).every((value) => typeof value === 'number' && Number.isFinite(value)));
          if (rawBars.length < 100) continue;
          finish(rawBars.map(([time, open, high, low, close, volume]) => {
            const openTime = time * 1000;
            return [openTime, String(open), String(high), String(low), String(close), String(volume), openTime + durationMs[interval] - 1];
          }));
        } catch { /* Ignore non-JSON protocol control frames. */ }
      }
    });
    socket.on('error', (error) => finish(undefined, error));
  });
}

async function connectHistory() {
  const history = {} as History;
  for (const interval of intervals) history[interval] = await connectInterval(interval);
  return history;
}

export function getTradingViewHistory() {
  if (cache.value && cache.expiresAt > Date.now()) return Promise.resolve(cache.value);
  if (cache.pending) return cache.pending;
  cache.pending = connectHistory().then((history) => {
    cache.value = history;
    cache.expiresAt = Date.now() + 30_000;
    return history;
  }).finally(() => { cache.pending = null; });
  return cache.pending;
}
