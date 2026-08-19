'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import MarketChart from './market-chart';
import PositionPanel from './position-panel';
import { emptyPosition, type PositionDraft } from './position';

type Interval = '15m' | '1h' | '4h' | '1d';
type Bias = 'bullish' | 'bearish' | 'neutral';
type TechnicalForm = {
  name: string; stage: string; direction: Bias; description: string;
  trigger: number | null; target: number | null; target2: number | null; invalidation: number | null;
  secondary?: { name: string; stage: string; direction: Bias; trigger: number | null };
};
type IndicatorCheck = { name: string; confirmed: boolean; provisional: boolean; available: boolean; text: string };
type IndicatorConfirmation = { count: number; provisionalCount: number; level: string; checks: IndicatorCheck[] };
type PatternCalculation = {
  calculable: boolean; active: boolean; method: string;
  height: number | null; formulaT1: string | null; formulaT2: string | null;
};
type SecondLegSetup = {
  direction: 'bullish' | 'bearish'; status: 'pullback' | 'testing' | 'active' | 'target_reached';
  statusLabel: string; trigger: number; target: number; invalidation: number;
  barsSincePullback: number; nextAction: string; formula: string;
};
type IntervalAnalysis = {
  interval: Interval; label: string; bias: Bias; biasLabel: string;
  livePrice: number; liveBarClosed: boolean; ema20: number; ema60: number;
  rsi14: number; atr14: number; macdHistogram: number; macdHistogramChange: number;
  relativeVolume: number; support20: number; resistance20: number;
  breakoutState: string; change1: number; technicalForm: TechnicalForm;
  contextWarning: string | null; indicatorSummary: string; indicatorConfirmation: IndicatorConfirmation;
  patternCalculation: PatternCalculation;
  secondLeg: { bullish: SecondLegSetup | null; bearish: SecondLegSetup | null };
};
type TradePlan = {
  interval: Interval; pattern: string; direction: Bias; stage: string;
  indicatorConfirmation: IndicatorConfirmation; shapeConfirmed: boolean;
  indicatorsConfirmed: boolean; qualified: boolean; confirmationPrice: number | null;
  retestZone: { low: number; high: number } | null; invalidation: number | null;
  hardStop: number | null; effectiveStop: number | null;
  measuredTarget: number | null; measuredTarget2: number | null; currentPrice: number; farFromTrigger: boolean; targetReached: boolean;
  executionText: string; riskDistance: number | null; structureRiskDistance: number | null;
  riskWarning: string; formula: string;
};
type ContractStatus = {
  connected: boolean; lastPrice?: number; lastTradeTime?: number; markPrice?: number; indexPrice?: number; fundingRate?: number;
  nextFundingTime?: number; bid?: number; ask?: number; connectedAt?: number;
};
type RoadmapStep = {
  label: string; low: number; high: number; status: 'passed' | 'testing' | 'waiting'; condition: string;
};
type MarketRoadmap = {
  headline: string; downsideHeadline: string; conclusion: string; downsideConclusion: string;
  upside: RoadmapStep[]; downside: RoadmapStep[];
};
type AnalysisResponse = {
  generatedAt: number; source: string; historySource: string; indicatorDataReliable: boolean; market: 'futures' | 'spot_fallback';
  contract: ContractStatus; symbol: string; currentPrice: number; overallBias: Bias;
  overallLabel: string; summary: string; analyses: Record<Interval, IntervalAnalysis>;
  marketRoadmap: MarketRoadmap;
  supports: number[]; resistances: number[]; measuredTarget: number | null; measuredSource: Interval | null;
  tradePlan: TradePlan; bullCondition: string; bearCondition: string; riskNote: string;
  ruleSet: string; modelStatus: string;
};

const intervals: Interval[] = ['15m', '1h', '4h', '1d'];
const roles: Record<Interval, string> = { '15m': '看眼前反弹强弱', '1h': '确认短线是否止跌', '4h': '决定波段方向', '1d': '决定大方向' };
const price = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const nullablePrice = (value: number | null) => value === null ? '—' : price(value);
const distanceText = (current: number, level: number | undefined) => {
  if (level === undefined) return '暂无可用距离';
  const points = Math.abs(current - level);
  const percent = points / current * 100;
  return `${price(points)} 点（${percent.toFixed(2)}%）`;
};
const zonePrice = (step: RoadmapStep) => step.low === step.high ? price(step.low) : `${price(step.low)} – ${price(step.high)}`;
const roadmapStatusText = (status: RoadmapStep['status'], direction: 'up' | 'down') => {
  if (status === 'testing') return '正在测试';
  if (status === 'passed') return direction === 'up' ? '已经站上' : '已经跌破';
  return '尚未到达';
};
const checkClass = (check: IndicatorCheck) => check.confirmed ? 'ok' : check.provisional ? 'provisional' : check.available ? '' : 'unavailable';
function directReason(item: IntervalAnalysis) {
  return item.technicalForm.description;
}

function CurrentPattern({ item }: { item: IntervalAnalysis }) {
  const form = item.technicalForm;
  const calculation = item.patternCalculation;
  const neutral = form.direction === 'neutral';
  const waveRank: Record<SecondLegSetup['status'], number> = { pullback: 0, testing: 1, active: 2, target_reached: 3 };
  const activeWave = [item.secondLeg.bullish, item.secondLeg.bearish]
    .filter((wave): wave is SecondLegSetup => wave !== null && wave.status !== 'pullback')
    .sort((left, right) => waveRank[right.status] - waveRank[left.status])[0];
  const triggerLabel = neutral ? '上边界' : form.direction === 'bullish' ? '突破确认' : '跌破确认';
  const invalidationLabel = neutral ? '下边界' : '形态失效';
  return <article className={`current-pattern ${form.direction} ${calculation.active ? 'active' : ''}`}>
    <div className="current-pattern-period"><strong>{item.label}</strong><span>{roles[item.interval]}</span></div>
    <div className="current-pattern-reading">
      <div className="current-pattern-title"><b>{form.name}</b><span>{form.stage}</span></div>
      <p>{directReason(item)}</p>
      {item.contextWarning && <p className="current-pattern-warning">{item.contextWarning}</p>}
      {form.secondary && <div className={`secondary-pattern ${form.secondary.direction}`}><b>{form.secondary.name}</b><span>{form.secondary.stage}{form.secondary.trigger !== null ? ` · 颈线 ${price(form.secondary.trigger)}` : ''}</span></div>}
      {activeWave && <div className={`supplemental-wave ${activeWave.direction}`}><b>同时出现{activeWave.direction === 'bullish' ? '上涨' : '下跌'}二波段：{activeWave.statusLabel}</b><span>启动 {price(activeWave.trigger)} · 等幅目标 {price(activeWave.target)} · 失效 {price(activeWave.invalidation)}</span><small>{activeWave.nextAction}</small></div>}
      <div className="current-pattern-checks">{item.indicatorConfirmation.checks.map((check) => <span className={checkClass(check)} title={check.text} key={check.name}>{check.name}{check.confirmed ? '：支持' : check.provisional ? '：盘中' : check.available ? '：不支持' : '：暂停'}</span>)}</div>
    </div>
    <div className="current-pattern-levels">
      <div className="current-pattern-state"><span>{calculation.active ? '量度目标已生效' : neutral ? '尚未选择方向' : '等待形态确认'}</span><b>{item.indicatorConfirmation.count}/4 项指标支持</b></div>
      <div className="pattern-level-grid">
        {form.trigger !== null && <div><span>{triggerLabel}</span><strong>{price(form.trigger)}</strong></div>}
        {form.target !== null && <div><span>{calculation.active ? 'T1' : '确认后 T1'}</span><strong>{price(form.target)}</strong></div>}
        {form.target2 !== null && <div><span>{calculation.active ? 'T2' : '确认后 T2'}</span><strong>{price(form.target2)}</strong></div>}
        {form.invalidation !== null && <div><span>{invalidationLabel}</span><strong>{price(form.invalidation)}</strong></div>}
      </div>
      <div className="pattern-calculation"><b>{calculation.method}</b>{calculation.formulaT1 && <span>T1：{calculation.formulaT1}</span>}{calculation.formulaT2 && <span>T2：{calculation.formulaT2}</span>}</div>
    </div>
  </article>;
}

function RoadmapColumn({ direction, steps }: { direction: 'up' | 'down'; steps: RoadmapStep[] }) {
  const visible = steps.slice(0, 3);
  const remaining = steps.slice(3);
  const renderSteps = (items: RoadmapStep[], offset = 0) => items.map((step, index) => <article className={step.status} key={`${step.label}-${step.low}`}>
    <div className="roadmap-index">{index + offset + 1}</div>
    <div className="roadmap-level"><span>{step.label}</span><strong>{zonePrice(step)}</strong><p>{step.condition}</p></div>
    <small>{roadmapStatusText(step.status, direction)}</small>
  </article>);
  return <div className={`roadmap-column ${direction}`}>
    <div className="roadmap-column-title"><b>{direction === 'up' ? '上涨路线' : '下跌路线'}</b><span>先看最近三步</span></div>
    <div className="roadmap-steps">{renderSteps(visible)}</div>
    {remaining.length > 0 && <details className="roadmap-more"><summary>后续点位（{remaining.length}）</summary><div className="roadmap-steps">{renderSteps(remaining, 3)}</div></details>}
  </div>;
}

export default function AnalysisPage() {
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedInterval, setSelectedInterval] = useState<Interval>('4h');
  const [position, setPosition] = useState<PositionDraft>(emptyPosition);
  const [positionReady, setPositionReady] = useState(false);
  const [error, setError] = useState('');
  const requestInFlight = useRef(false);
  const hasData = useRef(false);

  const analyze = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    if (!hasData.current) setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/analysis?t=${Date.now()}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '实时分析失败');
      setAnalysis(payload as AnalysisResponse);
      hasData.current = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '实时分析失败');
    } finally {
      setLoading(false);
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => { void analyze(); }, [analyze]);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('btc-contract-position-v1');
      if (saved) setPosition({ ...emptyPosition, ...JSON.parse(saved) as Partial<PositionDraft> });
    } catch { /* Invalid local data is ignored. */ }
    setPositionReady(true);
  }, []);
  useEffect(() => {
    if (!positionReady) return;
    window.localStorage.setItem('btc-contract-position-v1', JSON.stringify(position));
  }, [position, positionReady]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => { void analyze(); }, 3000);
    return () => window.clearInterval(timer);
  }, [analyze, autoRefresh]);

  const stance = analysis?.overallBias === 'bearish' ? '先防守，不追多'
    : analysis?.overallBias === 'bullish' ? '顺势看多，不追高' : '先等破位，不在中间猜方向';
  const mainItem = analysis?.analyses['4h'];
  const mainForm = mainItem?.technicalForm;
  const mainMissing = mainItem?.indicatorConfirmation.checks.filter((check) => check.available && !check.confirmed && !check.provisional).map((check) => check.name).join('、');
  const mainProvisional = mainItem?.indicatorConfirmation.checks.filter((check) => check.provisional).map((check) => check.name).join('、');
  const plainSummary = analysis && mainItem && mainForm
    ? `4小时当前是“${mainForm.name}”，${mainForm.stage}。关键线 ${nullablePrice(mainForm.trigger)}；${mainItem.indicatorConfirmation.count}/4 项已收盘支持${mainProvisional ? `，${mainProvisional}盘中支持` : ''}${mainMissing ? `；${mainMissing}尚未确认。` : '。'}`
    : '正在等待本次行情分析结果。';
  const activeUp = analysis?.marketRoadmap.upside.find((step) => step.status !== 'passed') ?? null;
  const activeDown = analysis?.marketRoadmap.downside.find((step) => step.status !== 'passed') ?? null;
  const upDistance = analysis && activeUp ? Math.max(0, activeUp.low - analysis.currentPrice) : Number.POSITIVE_INFINITY;
  const downDistance = analysis && activeDown ? Math.max(0, analysis.currentPrice - activeDown.high) : Number.POSITIVE_INFINITY;
  const focusStep = activeUp?.status === 'testing' ? activeUp
    : activeDown?.status === 'testing' ? activeDown
      : upDistance <= downDistance ? activeUp : activeDown;
  const focusDirection = focusStep === activeDown ? 'down' : 'up';
  const markDeviation = analysis?.contract.markPrice && analysis.currentPrice
    ? analysis.contract.markPrice / analysis.currentPrice - 1 : null;
  const quoteAge = analysis?.contract.lastTradeTime
    ? Math.max(0, analysis.generatedAt - analysis.contract.lastTradeTime) : null;

  return <main className="analysis-page direct-page">
    <header className="analysis-header">
      <div className="analysis-header-main">
        <span className="eyebrow">BTCUSDT 永续 · Binance 最新成交价</span>
        <div className="top-current-price">
          <strong>{analysis ? price(analysis.currentPrice) : '—'}</strong>
          <div>
            <span>{analysis?.contract.connected ? `标记价 ${price(analysis.contract.markPrice)}${markDeviation !== null ? ` · 与成交价相差 ${(Math.abs(markDeviation) * 100).toFixed(3)}%` : ''}` : loading ? '正在连接合约行情' : '等待行情'}</span>
            {analysis && <time>{new Date(analysis.generatedAt).toLocaleTimeString('zh-CN')} 更新{quoteAge !== null ? ` · 行情延迟约 ${(quoteAge / 1000).toFixed(1)}秒` : ''}</time>}
          </div>
        </div>
        <h1>BTC 现在怎么看</h1>
      </div>
    </header>
    <section className="live-controls">
      <div className={`live-control-status ${analysis?.contract.connected && analysis?.indicatorDataReliable ? 'connected' : ''}`}><i /><div><strong>{analysis?.contract.connected && analysis?.indicatorDataReliable ? '合约行情与指标已校准' : loading ? '正在连接合约行情' : analysis?.contract.connected ? '合约实时价已连接，指标暂缓' : '行情已更新（现货补充）'}</strong><span>{autoRefresh ? '每 3 秒自动更新点位' : '自动更新已暂停'}</span></div></div>
      <div className="live-actions"><label className="auto-refresh-switch"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /><span>3秒自动刷新</span></label>
      <button className="analyze-button" onClick={() => void analyze()} disabled={loading}>{loading ? '正在分析…' : '立即刷新'}</button></div>
    </section>
    {error && <div className="error">{error}</div>}
    {!analysis && !loading && <section className="direct-empty"><b>暂时没有分析结果</b><span>检查行情连接，或点击“立即刷新”重试。</span></section>}
    {analysis && <>
      <section className="chart-workspace">
        <div className="chart-timeframes">
          <div><span>选择周期，下面K线和形态说明会同步切换</span><b>周期形态</b></div>
          <div className="pattern-tabs" role="tablist" aria-label="K线周期">
            {intervals.map((interval) => <button type="button" role="tab" aria-selected={selectedInterval === interval} className={selectedInterval === interval ? 'active' : ''} onClick={() => setSelectedInterval(interval)} key={interval}><b>{analysis.analyses[interval].label}</b><span>{analysis.analyses[interval].technicalForm.name}</span></button>)}
          </div>
        </div>
        <MarketChart
          interval={selectedInterval}
          analysis={analysis.analyses[selectedInterval]}
          currentPrice={analysis.currentPrice}
          markPrice={analysis.contract.markPrice}
          position={position}
        />
      </section>
      <PositionPanel position={position} onChange={setPosition} analysis={analysis} markPrice={analysis.contract.markPrice} />
      <section className={`direct-verdict ${analysis.overallBias}`}>
        <div className="verdict-copy"><span>一句话结论</span><h2>{stance}</h2><p>{plainSummary}</p></div>
      </section>
      {focusStep && <section className={`market-focus ${focusDirection}`}>
        <div><span>现在最该盯</span><strong>{focusStep.label} {zonePrice(focusStep)}</strong><p>{focusStep.condition}</p></div>
        <div className="nearest-levels">
          <article><span>上方最近</span><b>{activeUp ? zonePrice(activeUp) : '暂无'}</b><small>{activeUp ? `距离约 ${distanceText(analysis.currentPrice, activeUp.low)}` : '暂无可计算压力'}</small></article>
          <article><span>下方最近</span><b>{activeDown ? zonePrice(activeDown) : '暂无'}</b><small>{activeDown ? `距离约 ${distanceText(analysis.currentPrice, activeDown.high)}` : '暂无可计算支撑'}</small></article>
        </div>
      </section>}
      <section className="current-patterns">
        <div className="current-patterns-heading"><div><span>实时识别结果</span><h2>{analysis.analyses[selectedInterval].label}形态说明</h2></div><p>形态线已经画在上方K线图；这里补充确认条件、量度点位和指标支持情况。</p></div>
        <div className="current-pattern-list"><CurrentPattern item={analysis.analyses[selectedInterval]} /></div>
      </section>
      <section className="exact-plan">
        <div className="exact-plan-head">
          <div><span className="exact-plan-kicker">具体点位 · {analysis.analyses[analysis.tradePlan.interval].label}主形态</span><h2>{analysis.tradePlan.pattern}</h2></div>
          <span className={`plan-status ${analysis.tradePlan.qualified ? 'ready' : 'waiting'}`}>{analysis.tradePlan.qualified ? '形态和指标均已确认' : analysis.tradePlan.shapeConfirmed ? '形态已破线，指标未确认' : '形态尚未确认'}</span>
        </div>
        <p className="exact-decision">{analysis.tradePlan.executionText}</p>
        <div className="exact-levels">
          <article className="confirm-level"><span>{analysis.tradePlan.shapeConfirmed ? '有效确认价' : '等待突破/跌破价'}</span><strong>{nullablePrice(analysis.tradePlan.confirmationPrice)}</strong><small>当前价与该点相差 {distanceText(analysis.currentPrice, analysis.tradePlan.confirmationPrice ?? undefined)}。</small></article>
          <article className="retest-level"><span>确认后的回测区</span><strong>{analysis.tradePlan.retestZone ? `${price(analysis.tradePlan.retestZone.low)} – ${price(analysis.tradePlan.retestZone.high)}` : '—'}</strong><small>{analysis.tradePlan.farFromTrigger ? '当前离确认线较远：不追，等价格回到这里。' : '突破后回到这里仍守住，形态可信度更高。'}</small></article>
          <article className="invalid-level"><span>执行止损位</span><strong>{nullablePrice(analysis.tradePlan.effectiveStop)}</strong><small>形态失效位 {nullablePrice(analysis.tradePlan.invalidation)}；6%硬止损 {nullablePrice(analysis.tradePlan.hardStop)}，执行更近者。</small></article>
          <article className="target-level"><span>{analysis.tradePlan.targetReached ? 'T1 已经到达' : '第一满足位 T1'}</span><strong>{nullablePrice(analysis.tradePlan.measuredTarget)}</strong><small>{analysis.tradePlan.targetReached ? '原形态的一倍量度目标已经兑现，不能作为当前追价理由。' : `相距 ${distanceText(analysis.tradePlan.confirmationPrice ?? analysis.currentPrice, analysis.tradePlan.measuredTarget ?? undefined)}；达到后规则参考为减仓1/2或上移保护位。`}</small></article>
        </div>
        <p className="exact-risk">{analysis.tradePlan.riskWarning}</p>
      </section>
      <section className="market-roadmap">
        <div className="roadmap-heading">
          <div><span>最后看路径</span><h2>上涨与下跌路线</h2></div>
          <p>只展开离现价最近的三步，更远目标按需查看。</p>
        </div>
        <div className="roadmap-summaries">
          <article className="up"><span>如果继续上涨</span><strong>{analysis.marketRoadmap.headline}</strong><p>{analysis.marketRoadmap.conclusion}</p></article>
          <article className="down"><span>如果转为下跌</span><strong>{analysis.marketRoadmap.downsideHeadline}</strong><p>{analysis.marketRoadmap.downsideConclusion}</p></article>
        </div>
        <div className="roadmap-columns">
          <RoadmapColumn direction="up" steps={analysis.marketRoadmap.upside} />
          <RoadmapColumn direction="down" steps={analysis.marketRoadmap.downside} />
        </div>
      </section>
    </>}
  </main>;
}
