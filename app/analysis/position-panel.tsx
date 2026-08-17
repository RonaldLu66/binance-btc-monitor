'use client';

import { numericPosition, type PositionDraft } from './position';

type Bias = 'bullish' | 'bearish' | 'neutral';
type PositionAnalysis = {
  currentPrice: number;
  overallBias: Bias;
  supports: number[];
  resistances: number[];
  tradePlan: { effectiveStop: number | null; measuredTarget: number | null; direction: Bias };
};

const price = (value: number | null | undefined) => value?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '—';
const usdt = (value: number | null) => value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT`;
const percent = (value: number | null) => value === null ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;

export default function PositionPanel({
  position, onChange, analysis, markPrice,
}: {
  position: PositionDraft;
  onChange: (position: PositionDraft) => void;
  analysis: PositionAnalysis;
  markPrice?: number;
}) {
  const values = numericPosition(position);
  const sign = position.side === 'long' ? 1 : -1;
  const complete = values.entryPrice !== null && values.quantityBtc !== null && values.leverage !== null;
  const notional = values.quantityBtc === null ? null : analysis.currentPrice * values.quantityBtc;
  const initialMargin = !complete ? null : values.entryPrice! * values.quantityBtc! / values.leverage!;
  const lastPnl = !complete ? null : sign * (analysis.currentPrice - values.entryPrice!) * values.quantityBtc!;
  const markPnl = !complete || !markPrice ? null : sign * (markPrice - values.entryPrice!) * values.quantityBtc!;
  const marginRoe = lastPnl === null || initialMargin === null ? null : lastPnl / initialMargin;
  const accountImpact = lastPnl === null || !values.accountEquity ? null : lastPnl / values.accountEquity;
  const fallbackDefense = position.side === 'long'
    ? (analysis.tradePlan.effectiveStop && analysis.tradePlan.effectiveStop < analysis.currentPrice ? analysis.tradePlan.effectiveStop : analysis.supports[0])
    : (analysis.tradePlan.effectiveStop && analysis.tradePlan.effectiveStop > analysis.currentPrice ? analysis.tradePlan.effectiveStop : analysis.resistances[0]);
  const defense = values.stopLoss ?? fallbackDefense ?? null;
  const target = position.side === 'long'
    ? analysis.resistances.find((level) => level > analysis.currentPrice) ?? (analysis.tradePlan.measuredTarget && analysis.tradePlan.measuredTarget > analysis.currentPrice ? analysis.tradePlan.measuredTarget : null)
    : analysis.supports.find((level) => level < analysis.currentPrice) ?? (analysis.tradePlan.measuredTarget && analysis.tradePlan.measuredTarget < analysis.currentPrice ? analysis.tradePlan.measuredTarget : null);
  const defenseDistance = defense ? Math.abs(analysis.currentPrice / defense - 1) : null;
  const targetDistance = target ? Math.abs(target / analysis.currentPrice - 1) : null;
  const liquidationDistance = values.liquidationPrice ? Math.abs(analysis.currentPrice / values.liquidationPrice - 1) : null;
  const lossAtStop = !complete || !defense ? null : sign * (defense - values.entryPrice!) * values.quantityBtc!;
  const maxQuantityAtOnePercent = !values.accountEquity || !values.entryPrice || !defense || Math.abs(values.entryPrice - defense) === 0
    ? null : values.accountEquity * 0.01 / Math.abs(values.entryPrice - defense);
  const exposureMultiple = notional === null || !values.accountEquity ? null : notional / values.accountEquity;
  const aligned = analysis.overallBias === 'neutral' ? null
    : (analysis.overallBias === 'bullish' && position.side === 'long') || (analysis.overallBias === 'bearish' && position.side === 'short');
  const defenseBroken = defense !== null && (position.side === 'long' ? analysis.currentPrice <= defense : analysis.currentPrice >= defense);
  const nearDefense = defenseDistance !== null && defenseDistance <= 0.004;
  const nearLiquidation = liquidationDistance !== null && liquidationDistance <= 0.015;
  const decision = !complete
    ? '先填开仓价、BTC数量和杠杆，系统才能把行情转换成与你仓位有关的风险。'
    : nearLiquidation
      ? `现价距离你填写的实际强平价仅 ${percent(liquidationDistance)}，仓位处于极高风险区。`
      : defenseBroken
        ? `现价已经越过防守位 ${price(defense)}，原有持仓逻辑已被破坏。`
        : nearDefense
          ? `现价距离防守位 ${price(defense)} 仅 ${percent(defenseDistance)}，现在首先看防守，不是看远端目标。`
          : aligned === false
            ? `你的${position.side === 'long' ? '多单' : '空单'}与当前多周期方向相反，防守位 ${price(defense)} 是最重要的观察点。`
            : `仓位暂未触发防守；上方/下方最近目标 ${price(target)}，距离约 ${percent(targetDistance)}。`;

  const set = (field: keyof PositionDraft, value: string) => onChange({ ...position, [field]: value });

  return <section className="position-panel">
    <div className="position-head">
      <div><span>把行情变成你的持仓判断</span><h2>我的合约仓位</h2></div>
      <small>仅保存在当前浏览器，不上传API Key</small>
    </div>
    <div className="position-form">
      <label><span>方向</span><select value={position.side} onChange={(event) => set('side', event.target.value)}><option value="long">多单</option><option value="short">空单</option></select></label>
      <label><span>开仓价</span><input inputMode="decimal" placeholder="例如 63750" value={position.entryPrice} onChange={(event) => set('entryPrice', event.target.value)} /></label>
      <label><span>持仓数量 BTC</span><input inputMode="decimal" placeholder="例如 0.10" value={position.quantityBtc} onChange={(event) => set('quantityBtc', event.target.value)} /></label>
      <label><span>杠杆</span><input inputMode="decimal" placeholder="例如 30" value={position.leverage} onChange={(event) => set('leverage', event.target.value)} /></label>
      <label><span>保证金模式</span><select value={position.marginMode} onChange={(event) => set('marginMode', event.target.value)}><option value="isolated">逐仓</option><option value="cross">全仓</option></select></label>
      <label><span>我的止损价（选填）</span><input inputMode="decimal" placeholder="以你的委托为准" value={position.stopLoss} onChange={(event) => set('stopLoss', event.target.value)} /></label>
      <label><span>Binance实际强平价</span><input inputMode="decimal" placeholder="从持仓页填写" value={position.liquidationPrice} onChange={(event) => set('liquidationPrice', event.target.value)} /></label>
      <label><span>账户权益 USDT（选填）</span><input inputMode="decimal" placeholder="用于计算账户风险" value={position.accountEquity} onChange={(event) => set('accountEquity', event.target.value)} /></label>
    </div>
    <div className={`position-decision ${defenseBroken || nearLiquidation ? 'danger' : nearDefense || aligned === false ? 'warning' : 'normal'}`}>
      <span>结合当前行情</span><strong>{decision}</strong>
    </div>
    <div className="position-metrics">
      <article><span>最新价浮盈亏</span><b className={(lastPnl ?? 0) >= 0 ? 'positive' : 'negative'}>{usdt(lastPnl)}</b><small>标记价口径 {usdt(markPnl)}</small></article>
      <article><span>保证金收益率</span><b className={(marginRoe ?? 0) >= 0 ? 'positive' : 'negative'}>{percent(marginRoe)}</b><small>账户权益影响 {percent(accountImpact)}</small></article>
      <article><span>{values.stopLoss ? '我的止损' : '系统防守参考'}</span><b>{price(defense)}</b><small>距离 {percent(defenseDistance)} · 到位盈亏 {usdt(lossAtStop)}</small></article>
      <article><span>最近形态目标</span><b>{price(target)}</b><small>距离现价 {percent(targetDistance)}</small></article>
    </div>
    <div className="position-risk-row">
      <span>名义价值 <b>{notional === null ? '—' : `${price(notional)} USDT`}</b></span>
      <span>估算初始保证金 <b>{initialMargin === null ? '—' : `${price(initialMargin)} USDT`}</b></span>
      <span>账户敞口 <b>{exposureMultiple === null ? '—' : `${exposureMultiple.toFixed(2)}倍`}</b></span>
      <span>距实际强平 <b>{percent(liquidationDistance)}</b></span>
      <span>按账户1%风险的数量参考 <b>{maxQuantityAtOnePercent === null ? '—' : `${maxQuantityAtOnePercent.toFixed(4)} BTC`}</b></span>
    </div>
    <p className="position-note">强平价必须填写 Binance 持仓页显示的实际数值；系统不会用简化公式替代交易所结果。手续费、资金费率和维持保证金未计入浮盈亏。</p>
  </section>;
}
