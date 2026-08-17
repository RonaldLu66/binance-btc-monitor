'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineStyle,
  createChart, createSeriesMarkers,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { numericPosition, type PositionDraft } from './position';

type Interval = '15m' | '1h' | '4h' | '1d';
type Bias = 'bullish' | 'bearish' | 'neutral';
type Pattern = {
  name: string; direction: Bias; trigger: number | null; target: number | null;
  target2: number | null; invalidation: number | null;
};
type ChartAnalysis = {
  technicalForm: Pattern; support20: number; resistance20: number;
};
type MarketPayload = {
  rows: unknown[][]; source: string; market: string; lastPrice?: number; markPrice?: number; serverTime: number;
};
type Candle = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

const intervalNames: Record<Interval, string> = { '15m': '15分钟', '1h': '1小时', '4h': '4小时', '1d': '日线' };
const formatPrice = (value: number | undefined) => value?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';

export default function MarketChart({
  interval, analysis, currentPrice, markPrice, position,
}: {
  interval: Interval;
  analysis: ChartAnalysis;
  currentPrice: number;
  markPrice?: number;
  position: PositionDraft;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const firstLoadRef = useRef(true);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [volumes, setVolumes] = useState<Array<{ time: UTCTimestamp; value: number; color: string }>>([]);
  const [source, setSource] = useState('正在连接 Binance 合约K线');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/market?interval=${interval}&t=${Date.now()}`, { cache: 'no-store' });
      const payload = await response.json() as MarketPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'K线加载失败');
      const nextCandles = payload.rows.map((row) => ({
        time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp,
        open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
      })).filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
      const nextVolumes = payload.rows.map((row) => ({
        time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp,
        value: Number(row[5]),
        color: Number(row[4]) >= Number(row[1]) ? 'rgba(53, 211, 153, 0.38)' : 'rgba(255, 113, 140, 0.38)',
      })).filter((bar) => Number.isFinite(bar.value));
      setCandles(nextCandles);
      setVolumes(nextVolumes);
      setSource(payload.source);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'K线加载失败');
    }
  }, [interval]);

  useEffect(() => {
    firstLoadRef.current = true;
    void load();
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      height: 460,
      layout: { background: { type: ColorType.Solid, color: '#081521' }, textColor: '#8298ac' },
      grid: { vertLines: { color: '#13283a' }, horzLines: { color: '#13283a' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#263b4e', scaleMargins: { top: 0.06, bottom: 0.22 } },
      timeScale: { borderColor: '#263b4e', timeVisible: true, secondsVisible: false, rightOffset: 4 },
      localization: { locale: 'zh-CN', priceFormatter: (value: number) => formatPrice(value) },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#35d399', downColor: '#ff718c', borderVisible: false,
      wickUpColor: '#35d399', wickDownColor: '#ff718c', priceLineVisible: true,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    markersRef.current = createSeriesMarkers(candleSeries, []);
    return () => {
      markersRef.current?.detach();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      markersRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!candles.length || !candleRef.current || !volumeRef.current || !chartRef.current) return;
    candleRef.current.setData(candles);
    volumeRef.current.setData(volumes);
    if (firstLoadRef.current) {
      chartRef.current.timeScale().fitContent();
      firstLoadRef.current = false;
    }
  }, [candles, volumes]);

  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    const addLine = (value: number | null | undefined, title: string, color: string, style = LineStyle.Dashed, width: 1 | 2 | 3 | 4 = 1) => {
      if (!value || !Number.isFinite(value)) return;
      priceLinesRef.current.push(series.createPriceLine({ price: value, title, color, lineStyle: style, lineWidth: width, axisLabelVisible: true }));
    };
    const form = analysis.technicalForm;
    addLine(form.trigger, form.direction === 'neutral' ? '上边界' : '确认线', '#62a8df', LineStyle.Solid, 2);
    addLine(form.target, 'T1', form.direction === 'bearish' ? '#ff718c' : '#35d399', LineStyle.Dashed, 2);
    addLine(form.target2, 'T2', form.direction === 'bearish' ? '#c8556b' : '#278f70');
    addLine(form.invalidation, form.direction === 'neutral' ? '下边界' : '形态失效', '#ff9b59', LineStyle.Solid, 2);
    addLine(analysis.support20, '近20根支撑', '#3b8f75');
    addLine(analysis.resistance20, '近20根压力', '#a94a60');
    if (markPrice && Math.abs(markPrice / currentPrice - 1) >= 0.00005) addLine(markPrice, '标记价', '#d8ad54', LineStyle.Dotted);
    const numeric = numericPosition(position);
    addLine(numeric.entryPrice, position.side === 'long' ? '多单开仓' : '空单开仓', '#f0b35b', LineStyle.Solid, 2);
    addLine(numeric.stopLoss, '我的止损', '#ff5f7a', LineStyle.Solid, 2);
    addLine(numeric.liquidationPrice, '实际强平', '#d85cff', LineStyle.Solid, 2);
  }, [analysis, currentPrice, markPrice, position]);

  useEffect(() => {
    if (!candleRef.current || !candles.length) return;
    const trigger = analysis.technicalForm.trigger;
    const direction = analysis.technicalForm.direction;
    if (!trigger || direction === 'neutral') {
      markersRef.current?.setMarkers([]);
      return;
    }
    const recent = candles.slice(-90);
    const markers: Array<{ time: UTCTimestamp; position: 'aboveBar' | 'belowBar'; color: string; shape: 'arrowUp' | 'arrowDown' | 'circle'; text: string }> = [];
    let crossedAt = -1;
    for (let index = 1; index < recent.length; index += 1) {
      const crossed = direction === 'bullish'
        ? recent[index - 1].close <= trigger && recent[index].close > trigger
        : recent[index - 1].close >= trigger && recent[index].close < trigger;
      if (crossed) crossedAt = index;
    }
    if (crossedAt >= 0) {
      markers.push({
        time: recent[crossedAt].time,
        position: direction === 'bullish' ? 'belowBar' : 'aboveBar',
        color: direction === 'bullish' ? '#35d399' : '#ff718c',
        shape: direction === 'bullish' ? 'arrowUp' : 'arrowDown', text: direction === 'bullish' ? '突破' : '跌破',
      });
      const retestIndex = recent.findIndex((bar, index) => index > crossedAt && (direction === 'bullish'
        ? bar.low <= trigger * 1.0015 && bar.close >= trigger
        : bar.high >= trigger * 0.9985 && bar.close <= trigger));
      if (retestIndex > crossedAt) markers.push({
        time: recent[retestIndex].time,
        position: direction === 'bullish' ? 'belowBar' : 'aboveBar',
        color: '#e5b95c', shape: 'circle', text: direction === 'bullish' ? '回测守住' : '反抽受阻',
      });
    }
    markersRef.current?.setMarkers(markers);
  }, [analysis, candles]);

  return <section className="market-chart-card">
    <div className="market-chart-head">
      <div><span>Binance BTCUSDT 永续</span><h2>{intervalNames[interval]}实时K线 · 形态点位已标注</h2></div>
      <div className="chart-price"><span>最新成交价</span><b>{formatPrice(currentPrice)}</b></div>
    </div>
    <div className="chart-legend">
      <span className="confirm">确认线</span><span className="target">T1 / T2</span><span className="invalid">失效线</span><span className="position">我的仓位</span>
    </div>
    <div className="market-chart" ref={containerRef} />
    <div className="chart-source"><span>{source}</span><span>每3秒同步，十字光标可查看精确OHLC</span></div>
    {error && <p className="chart-error">{error}</p>}
  </section>;
}
