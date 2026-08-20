import { NextResponse } from 'next/server';
import { getFuturesSnapshot, type FuturesKline } from '../../futures-stream';
import { getBinanceFuturesHistory, getBinanceFuturesQuote } from '../../binance-futures-history';
import { getTradingViewHistory } from '../../tradingview-history';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

type Interval = '15m' | '1h' | '4h' | '1d';
type Direction = 'bullish' | 'bearish' | 'neutral';
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];
type Kline = { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number };
type TechnicalPattern = {
  name: string; stage: string; direction: Direction; description: string;
  trigger: number | null; target: number | null; target2: number | null; invalidation: number | null;
  trendlines?: { upper: Array<{ time: number; price: number }>; lower: Array<{ time: number; price: number }> };
  points?: Array<{ time: number; price: number; label: string; position: 'aboveBar' | 'belowBar' }>;
  secondary?: { name: string; stage: string; direction: Direction; trigger: number | null };
};
type PatternCalculation = {
  calculable: boolean; active: boolean; method: string;
  height: number | null; formulaT1: string | null; formulaT2: string | null;
};
type StructureContext = {
  text: string; pattern: string; direction: Direction; keyLevel: number; target: number | null;
};
type WaveStatus = 'pullback' | 'testing' | 'active' | 'target_reached';
type WaveStructure = {
  direction: 'bullish' | 'bearish'; status: WaveStatus; start: number; firstEnd: number; pullback: number;
  trigger: number; target: number; invalidation: number; structureInvalidation: number;
  firstLegPoints: number; retracement: number; barsSincePullback: number;
  distanceToTrigger: number; distanceToTarget: number;
};

const intervalLabels: Record<Interval, string> = { '15m': '15分钟', '1h': '1小时', '4h': '4小时', '1d': '日线' };
const intervalWeights: Record<Interval, number> = { '15m': 1, '1h': 2, '4h': 3, '1d': 4 };
const intervals = Object.keys(intervalLabels) as Interval[];
const marketSource = 'Binance Spot（合约数据暂不可用时降级）';
const bullishVolumeThreshold = 1.5;
const hardStopRate = 0.06;

function ema(values: number[], period: number) {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  let current = values[0];
  return values.map((value, index) => {
    current = index === 0 ? value : alpha * value + (1 - alpha) * current;
    return current;
  });
}

function rsi(values: number[], period = 14) {
  if (values.length <= period) return 50;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= period;
  averageLoss /= period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  return averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
}

function atr(klines: Kline[], period = 14) {
  const ranges = klines.map((bar, index) => {
    const previousClose = klines[Math.max(0, index - 1)].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
  return ema(ranges, period).at(-1) ?? 0;
}

function average(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function formatPrice(value: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatPercent(value: number) {
  return `${Math.abs(value * 100).toFixed(2)}%`;
}

function pricePosition(current: number, level: number) {
  const distance = current / level - 1;
  if (Math.abs(distance) < 0.0001) return `正贴近 ${formatPrice(level)}`;
  return distance > 0
    ? `位于 ${formatPrice(level)} 上方 ${formatPrice(current - level)} 点（${formatPercent(distance)}）`
    : `位于 ${formatPrice(level)} 下方 ${formatPrice(level - current)} 点（${formatPercent(distance)}）`;
}

type Pivot = { index: number; price: number; kind: 'high' | 'low' };

function pivots(bars: Kline[], span = 2) {
  const output: Pivot[] = [];
  for (let index = span; index < bars.length - span; index += 1) {
    const window = bars.slice(index - span, index + span + 1);
    if (bars[index].high === Math.max(...window.map((bar) => bar.high))) output.push({ index, price: bars[index].high, kind: 'high' });
    if (bars[index].low === Math.min(...window.map((bar) => bar.low))) output.push({ index, price: bars[index].low, kind: 'low' });
  }
  return output;
}

function alternatingPivots(bars: Kline[], currentAtr: number) {
  const points = pivots(bars, 2);
  const lastPoint = points.at(-1);
  if (lastPoint) {
    const tail = bars.slice(lastPoint.index + 1);
    if (tail.length >= 2) {
      if (lastPoint.kind === 'high') {
        const price = Math.min(...tail.map((bar) => bar.low));
        const offset = tail.findIndex((bar) => bar.low === price);
        const bounced = bars.at(-1)!.close - price >= currentAtr * 0.12;
        if (bounced || tail.length >= 3) points.push({ index: lastPoint.index + 1 + offset, price, kind: 'low' });
      } else {
        const price = Math.max(...tail.map((bar) => bar.high));
        const offset = tail.findIndex((bar) => bar.high === price);
        const rejected = price - bars.at(-1)!.close >= currentAtr * 0.12;
        if (rejected || tail.length >= 3) points.push({ index: lastPoint.index + 1 + offset, price, kind: 'high' });
      }
    }
  }

  return points.reduce<Pivot[]>((output, point) => {
    const previous = output.at(-1);
    if (!previous || previous.kind !== point.kind) return [...output, point];
    const moreExtreme = point.kind === 'high' ? point.price > previous.price : point.price < previous.price;
    return moreExtreme ? [...output.slice(0, -1), point] : output;
  }, []);
}

type TriangleCandidate = {
  highs: Pivot[];
  lows: Pivot[];
  height: number;
  lastIndex: number;
};

function findConvergingTriangle(highs: Pivot[], lows: Pivot[], currentAtr: number, recentLength: number) {
  const structureNoise = currentAtr * 0.25;
  let best: TriangleCandidate | null = null;
  const highStartFloor = Math.max(0, highs.length - 6);
  const lowStartFloor = Math.max(0, lows.length - 6);

  for (let highStart = highStartFloor; highStart <= highs.length - 3; highStart += 1) {
    const candidateHighs = highs.slice(highStart, highStart + 3);
    for (let lowStart = lowStartFloor; lowStart <= lows.length - 3; lowStart += 1) {
      const candidateLows = lows.slice(lowStart, lowStart + 3);
      const firstIndex = Math.min(candidateHighs[0].index, candidateLows[0].index);
      const lastIndex = Math.max(candidateHighs.at(-1)!.index, candidateLows.at(-1)!.index);
      const highDrop = candidateHighs[0].price - candidateHighs.at(-1)!.price;
      const lowRise = candidateLows.at(-1)!.price - candidateLows[0].price;
      const initialRange = Math.max(...candidateHighs.map((point) => point.price))
        - Math.min(...candidateLows.map((point) => point.price));
      const finalRange = candidateHighs.at(-1)!.price - candidateLows.at(-1)!.price;
      const span = lastIndex - firstIndex;
      const recentEnough = lastIndex >= recentLength - 40;
      const slopesValid = highDrop > structureNoise && lowRise > structureNoise;
      const rangeContracted = initialRange > currentAtr * 1.5 && finalRange > 0
        && finalRange <= initialRange * 0.75;
      if (!recentEnough || span < 6 || span > 40 || !slopesValid || !rangeContracted) continue;
      if (!best || lastIndex > best.lastIndex) {
        best = { highs: candidateHighs, lows: candidateLows, height: initialRange, lastIndex };
      }
    }
  }
  return best;
}

function convergingTrianglePattern(
  triangle: TriangleCandidate, currentAtr: number, lastClosed: Kline, live: Kline, recent: Kline[],
): TechnicalPattern {
  const upperTrigger = triangle.highs.at(-1)!.price;
  const lowerTrigger = triangle.lows.at(-1)!.price;
  const confirmationBuffer = currentAtr * 0.10;
  const closedUp = lastClosed.close > upperTrigger + confirmationBuffer;
  const closedDown = lastClosed.close < lowerTrigger - confirmationBuffer;
  const liveUp = live.close > upperTrigger;
  const liveDown = live.close < lowerTrigger;
  const highText = `${formatPrice(triangle.highs[0].price)}→${formatPrice(triangle.highs.at(-1)!.price)}`;
  const lowText = `${formatPrice(triangle.lows[0].price)}→${formatPrice(triangle.lows.at(-1)!.price)}`;
  const trendlines = {
    upper: triangle.highs.map((point) => ({ time: recent[point.index].openTime, price: point.price })),
    lower: triangle.lows.map((point) => ({ time: recent[point.index].openTime, price: point.price })),
  };
  if (closedUp || liveUp) return {
    name: '收敛三角形向上突破',
    stage: closedUp ? '实体突破，等待回测确认' : '盘中突破，等待收盘确认',
    direction: 'bullish',
    description: `三组摆点显示上沿从 ${highText} 下移、下沿从 ${lowText} 抬高，区间由约 ${formatPrice(triangle.height)} 点收窄。当前价已越过 ${formatPrice(upperTrigger)} 上沿；先看回踩 ${formatPrice(upperTrigger)} 是否守住，守住才算突破有效。`,
    trigger: upperTrigger, target: upperTrigger + triangle.height, target2: upperTrigger + triangle.height * 2,
    invalidation: lowerTrigger, trendlines,
  };
  if (closedDown || liveDown) return {
    name: '收敛三角形向下突破',
    stage: closedDown ? '实体跌破，等待反抽确认' : '盘中跌破，等待收盘确认',
    direction: 'bearish',
    description: `三组摆点显示上沿从 ${highText} 下移、下沿从 ${lowText} 抬高，区间由约 ${formatPrice(triangle.height)} 点收窄。当前价已跌破 ${formatPrice(lowerTrigger)} 下沿；先看反抽 ${formatPrice(lowerTrigger)} 是否站不回，站不回才算跌破有效。`,
    trigger: lowerTrigger, target: lowerTrigger - triangle.height, target2: lowerTrigger - triangle.height * 2,
    invalidation: upperTrigger, trendlines,
  };
  return {
    name: '收敛三角形', stage: '收敛中，等待实体选择方向', direction: 'neutral',
    description: `三组摆点显示上沿从 ${highText} 下移、下沿从 ${lowText} 抬高，区间由约 ${formatPrice(triangle.height)} 点收窄。现价仍在 ${formatPrice(lowerTrigger)}–${formatPrice(upperTrigger)} 之间，未破线前不预设方向。`,
    trigger: upperTrigger, target: null, target2: null, invalidation: lowerTrigger, trendlines,
  };
}

type DoublePatternCandidate = {
  kind: 'bottom' | 'top'; first: Pivot; second: Pivot; middle: Pivot;
  neckline: number; extreme: number; height: number; gap: number; separation: number;
  priceBroken: boolean; confirmed: boolean; breakoutVolumeRatio: number | null; score: number;
};

function findDoublePatternCandidates(
  recent: Kline[], swingPoints: Pivot[], currentAtr: number, lastClosed: Kline,
  relativeVolume: number, kind: 'bottom' | 'top',
) {
  const points = swingPoints.filter((point) => point.kind === (kind === 'bottom' ? 'low' : 'high')).slice(-8);
  const candidates: DoublePatternCandidate[] = [];
  for (let leftIndex = 0; leftIndex < points.length - 1; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
      const first = points[leftIndex];
      const second = points[rightIndex];
      const separation = second.index - first.index;
      if (separation < 4 || separation > 48) continue;
      const between = recent.slice(first.index, second.index + 1);
      const neckline = kind === 'bottom'
        ? Math.max(...between.map((bar) => bar.high))
        : Math.min(...between.map((bar) => bar.low));
      const middleOffset = between.findIndex((bar) => kind === 'bottom' ? bar.high === neckline : bar.low === neckline);
      const middle: Pivot = {
        index: first.index + middleOffset,
        price: neckline,
        kind: kind === 'bottom' ? 'high' : 'low',
      };
      const extreme = kind === 'bottom'
        ? Math.min(first.price, second.price)
        : Math.max(first.price, second.price);
      const height = Math.abs(neckline - extreme);
      const gap = Math.abs(first.price - second.price);
      const comparable = height >= currentAtr * 1.10
        && gap <= currentAtr * 1.25
        && gap <= height * 0.40;
      if (!comparable) continue;
      const breakBuffer = currentAtr * 0.10;
      const priceBroken = kind === 'bottom'
        ? lastClosed.close > neckline + breakBuffer
        : lastClosed.close < neckline - breakBuffer;
      const breakoutIndex = recent.findIndex((bar, index) => index > second.index
        && bar.openTime <= lastClosed.openTime
        && (kind === 'bottom' ? bar.close > neckline + breakBuffer : bar.close < neckline - breakBuffer));
      const breakoutVolumeRatio = breakoutIndex >= 0
        ? recent[breakoutIndex].volume / Math.max(average(recent.slice(Math.max(0, breakoutIndex - 20), breakoutIndex).map((bar) => bar.volume)), 1e-9)
        : null;
      const confirmed = kind === 'bottom'
        ? priceBroken && (breakoutVolumeRatio ?? relativeVolume) >= bullishVolumeThreshold
        : priceBroken;
      const age = recent.length - 1 - second.index;
      if (!priceBroken && age > 18) continue;
      const similarity = 1 - Math.min(gap / Math.max(height, 1), 1);
      const completionScore = confirmed ? 300 : priceBroken ? 230 : 100;
      const score = completionScore + similarity * 30 + Math.min(height / Math.max(currentAtr, 1), 4) * 8 - age * 1.25;
      candidates.push({ kind, first, second, middle, neckline, extreme, height, gap, separation, priceBroken, confirmed, breakoutVolumeRatio, score });
    }
  }
  return candidates.sort((left, right) => right.score - left.score);
}

function doublePatternToTechnical(
  candidate: DoublePatternCandidate, recent: Kline[], live: Kline, relativeVolume: number,
): TechnicalPattern {
  const bullish = candidate.kind === 'bottom';
  const direction: Direction = bullish ? 'bullish' : 'bearish';
  const name = bullish ? 'W底' : 'M头';
  const target = bullish ? candidate.neckline + candidate.height : candidate.neckline - candidate.height;
  const target2 = bullish ? candidate.neckline + candidate.height * 2 : candidate.neckline - candidate.height * 2;
  const targetReached = bullish ? live.close >= target : live.close <= target;
  const target2Reached = bullish ? live.close >= target2 : live.close <= target2;
  const stage = candidate.confirmed
    ? target2Reached ? `已经确认，二倍量度目标已到达`
      : targetReached ? `已经确认，一倍量度目标已到达`
        : bullish ? '实体带量突破颈线，已经确认' : '实体收盘跌破颈线，已经确认'
    : candidate.priceBroken
      ? bullish ? '实体已突破，量能不足，仍按W底主结构观察' : '实体已经跌破，等待确认'
      : bullish ? '双底形成，等待实体突破颈线' : '双顶形成，等待实体跌破颈线';
  const pointText = bullish
    ? `左底 ${formatPrice(candidate.first.price)}，中间反弹高点 ${formatPrice(candidate.neckline)}，右底 ${formatPrice(candidate.second.price)}`
    : `左顶 ${formatPrice(candidate.first.price)}，中间回落低点 ${formatPrice(candidate.neckline)}，右顶 ${formatPrice(candidate.second.price)}`;
  const stateText = candidate.confirmed
    ? target2Reached
      ? `一倍目标 ${formatPrice(target)} 和二倍目标 ${formatPrice(target2)} 都已兑现，当前已超出这个形态的量度范围，不能再把W/M量度目标当成追价依据；结构分界仍看 ${formatPrice(candidate.neckline)}。`
      : targetReached
        ? `一倍目标 ${formatPrice(target)} 已兑现，下一量度位是 ${formatPrice(target2)}；此时优先保护已有利润，不把已兑现的一倍目标当成新开仓理由。`
        : bullish
      ? `上一根完整K线已带量站上颈线，W底确认；守住 ${formatPrice(candidate.neckline)}，量度目标先看 ${formatPrice(target)}。`
      : `上一根完整K线已收在颈线下方，M头确认；不能收回 ${formatPrice(candidate.neckline)}，量度目标先看 ${formatPrice(target)}。`
    : candidate.priceBroken
      ? bullish
        ? `实体已经站上颈线，但突破K线量能只有此前20根均量的 ${(candidate.breakoutVolumeRatio ?? relativeVolume).toFixed(2)} 倍；结构是W底，确认强度不足，回踩 ${formatPrice(candidate.neckline)} 是关键。`
        : `实体已经跌破颈线，继续看反抽能否收回 ${formatPrice(candidate.neckline)}。`
      : `当前价${pricePosition(live.close, candidate.neckline)}，还没有完成${bullish ? '向上突破' : '向下跌破'}。`;
  return {
    name, stage, direction,
    description: `${pointText}。两端相差 ${formatPrice(candidate.gap)} 点，间隔 ${candidate.separation} 根K线，形态高度 ${formatPrice(candidate.height)} 点。${stateText}`,
    trigger: candidate.neckline, target, target2,
    invalidation: candidate.neckline,
    points: [
      { time: recent[candidate.first.index].openTime, price: candidate.first.price, label: bullish ? '左底' : '左顶', position: bullish ? 'belowBar' : 'aboveBar' },
      { time: recent[candidate.middle.index].openTime, price: candidate.middle.price, label: bullish ? '颈线高点' : '颈线低点', position: bullish ? 'aboveBar' : 'belowBar' },
      { time: recent[candidate.second.index].openTime, price: candidate.second.price, label: bullish ? '右底' : '右顶', position: bullish ? 'belowBar' : 'aboveBar' },
    ],
    trendlines: bullish
      ? {
        upper: [{ time: recent[candidate.first.index].openTime, price: candidate.neckline }, { time: recent[candidate.second.index].openTime, price: candidate.neckline }],
        lower: [candidate.first, candidate.middle, candidate.second].map((point) => ({ time: recent[point.index].openTime, price: point.price })),
      }
      : {
        upper: [candidate.first, candidate.middle, candidate.second].map((point) => ({ time: recent[point.index].openTime, price: point.price })),
        lower: [{ time: recent[candidate.first.index].openTime, price: candidate.neckline }, { time: recent[candidate.second.index].openTime, price: candidate.neckline }],
      },
  };
}

function extremePivot(bars: Kline[], start: number, end: number, kind: 'high' | 'low'): Pivot {
  const segment = bars.slice(start, end + 1);
  const price = kind === 'high'
    ? Math.max(...segment.map((bar) => bar.high))
    : Math.min(...segment.map((bar) => bar.low));
  const offset = segment.findIndex((bar) => kind === 'high' ? bar.high === price : bar.low === price);
  return { index: start + offset, price, kind };
}

function linePrice(first: Pivot, second: Pivot, index: number) {
  const slope = (second.price - first.price) / Math.max(second.index - first.index, 1);
  return first.price + slope * (index - first.index);
}

function headAndShouldersPattern(
  recent: Kline[], left: Pivot, head: Pivot, right: Pivot, currentAtr: number,
  lastClosed: Kline, live: Kline, relativeVolume: number, kind: 'bottom' | 'top',
): TechnicalPattern {
  const bullish = kind === 'bottom';
  const reactionKind = bullish ? 'high' : 'low';
  const firstReaction = extremePivot(recent, left.index, head.index, reactionKind);
  const secondReaction = extremePivot(recent, head.index, right.index, reactionKind);
  const necklineAtHead = linePrice(firstReaction, secondReaction, head.index);
  const height = Math.abs(necklineAtHead - head.price);
  const lastClosedIndex = recent.findIndex((bar) => bar.openTime === lastClosed.openTime);
  const breakBuffer = currentAtr * 0.10;
  let breakoutIndex = -1;
  for (let index = right.index + 1; index <= lastClosedIndex; index += 1) {
    const neckline = linePrice(firstReaction, secondReaction, index);
    const broken = bullish
      ? recent[index].close > neckline + breakBuffer
      : recent[index].close < neckline - breakBuffer;
    if (broken) {
      breakoutIndex = index;
      break;
    }
  }
  const referenceIndex = breakoutIndex >= 0 ? breakoutIndex : Math.max(lastClosedIndex, right.index);
  const trigger = linePrice(firstReaction, secondReaction, referenceIndex);
  const breakoutVolumeRatio = breakoutIndex >= 0
    ? recent[breakoutIndex].volume / Math.max(average(recent.slice(Math.max(0, breakoutIndex - 20), breakoutIndex).map((bar) => bar.volume)), 1e-9)
    : null;
  const priceBroken = breakoutIndex >= 0;
  const confirmed = bullish
    ? priceBroken && (breakoutVolumeRatio ?? relativeVolume) >= bullishVolumeThreshold
    : priceBroken;
  const target = bullish ? trigger + height : trigger - height;
  const target2 = bullish ? trigger + height * 2 : trigger - height * 2;
  const targetReached = bullish ? live.close >= target : live.close <= target;
  const target2Reached = bullish ? live.close >= target2 : live.close <= target2;
  const name = bullish ? '头肩底' : '头肩顶';
  const stage = confirmed
    ? target2Reached ? '已经确认，第二阶段满足位已到达'
      : targetReached ? '已经确认，第一阶段满足位已到达'
        : bullish ? '实体带量突破斜颈线，已经确认' : '实体收盘跌破斜颈线，已经确认'
    : priceBroken
      ? bullish ? '实体突破斜颈线但量能不足，未确认' : '实体跌破斜颈线，等待反抽确认'
      : bullish ? '形态形成，等待实体带量突破斜颈线' : '形态形成，等待实体跌破斜颈线';
  const calculationText = `头部日期的颈线价 ${formatPrice(necklineAtHead)} − 头部 ${formatPrice(head.price)} = 形态高度 ${formatPrice(height)}；突破日期的颈线价 ${formatPrice(trigger)} ${bullish ? '+' : '−'} ${formatPrice(height)} = 第一阶段 ${formatPrice(target)}。`;
  const stateText = confirmed
    ? target2Reached
      ? `第一阶段 ${formatPrice(target)}、第二阶段 ${formatPrice(target2)} 都已兑现，不能再作为追价依据。`
      : targetReached
        ? `第一阶段 ${formatPrice(target)} 已兑现；当前尚未兑现的是第二阶段 ${formatPrice(target2)}。`
        : `形态已经确认，第一阶段满足位看 ${formatPrice(target)}。`
    : priceBroken
      ? bullish
        ? `突破K线量能为此前20根均量的 ${(breakoutVolumeRatio ?? relativeVolume).toFixed(2)} 倍，未达到 ${bullishVolumeThreshold.toFixed(2)} 倍。`
        : `已经出现实体跌破，继续看反抽能否收回斜颈线。`
      : `尚未完成${bullish ? '向上突破' : '向下跌破'}。`;
  const lineEndIndex = Math.max(referenceIndex, right.index);
  return {
    name, stage, direction: bullish ? 'bullish' : 'bearish',
    description: `左肩 ${formatPrice(left.price)}、头部 ${formatPrice(head.price)}、右肩 ${formatPrice(right.price)}。颈线由 ${formatPrice(firstReaction.price)} 与 ${formatPrice(secondReaction.price)} 两个反弹点连接，不按水平线计算。${calculationText}${stateText}`,
    trigger, target, target2, invalidation: right.price,
    points: [
      { time: recent[left.index].openTime, price: left.price, label: '左肩', position: bullish ? 'belowBar' : 'aboveBar' },
      { time: recent[head.index].openTime, price: head.price, label: '头部', position: bullish ? 'belowBar' : 'aboveBar' },
      { time: recent[right.index].openTime, price: right.price, label: '右肩', position: bullish ? 'belowBar' : 'aboveBar' },
      { time: recent[firstReaction.index].openTime, price: firstReaction.price, label: '颈线点1', position: bullish ? 'aboveBar' : 'belowBar' },
      { time: recent[secondReaction.index].openTime, price: secondReaction.price, label: '颈线点2', position: bullish ? 'aboveBar' : 'belowBar' },
    ],
    trendlines: bullish
      ? {
        upper: [firstReaction, secondReaction, { index: lineEndIndex, price: linePrice(firstReaction, secondReaction, lineEndIndex), kind: 'high' as const }]
          .map((point) => ({ time: recent[point.index].openTime, price: point.price })),
        lower: [left, head, right].map((point) => ({ time: recent[point.index].openTime, price: point.price })),
      }
      : {
        upper: [left, head, right].map((point) => ({ time: recent[point.index].openTime, price: point.price })),
        lower: [firstReaction, secondReaction, { index: lineEndIndex, price: linePrice(firstReaction, secondReaction, lineEndIndex), kind: 'low' as const }]
          .map((point) => ({ time: recent[point.index].openTime, price: point.price })),
      },
  };
}

function detectSecondLeg(
  closed: Kline[], live: Kline, currentAtr: number, direction: 'bullish' | 'bearish', liveBarClosed: boolean,
): WaveStructure | null {
  const bars = live.openTime > closed.at(-1)!.openTime
    ? [...closed.slice(-70), live]
    : [...closed.slice(-69, -1), live];
  const swingPoints = alternatingPivots(bars, currentAtr);
  const candidates: Array<{ start: Pivot; firstEnd: Pivot; pullback: Pivot; height: number; retracement: number }> = [];

  for (let index = 0; index <= swingPoints.length - 3; index += 1) {
    const [start, firstEnd, pullback] = swingPoints.slice(index, index + 3);
    const correctOrder = direction === 'bullish'
      ? start.kind === 'low' && firstEnd.kind === 'high' && pullback.kind === 'low'
      : start.kind === 'high' && firstEnd.kind === 'low' && pullback.kind === 'high';
    if (!correctOrder) continue;
    const height = Math.abs(firstEnd.price - start.price);
    const retracement = direction === 'bullish'
      ? (firstEnd.price - pullback.price) / Math.max(height, 1e-9)
      : (pullback.price - firstEnd.price) / Math.max(height, 1e-9);
    const structureHeld = direction === 'bullish'
      ? pullback.price > start.price - currentAtr * 0.10
      : pullback.price < start.price + currentAtr * 0.10;
    const meaningfulLeg = height >= Math.max(currentAtr * 1.35, firstEnd.price * 0.002);
    if (meaningfulLeg && structureHeld && retracement >= 0.12 && retracement <= 0.88) {
      candidates.push({ start, firstEnd, pullback, height, retracement });
    }
  }

  const candidate = candidates.at(-1);
  if (!candidate) return null;
  const { start, firstEnd, pullback, height, retracement } = candidate;
  const target = direction === 'bullish' ? pullback.price + height : pullback.price - height;
  const trigger = firstEnd.price;
  const currentPrice = live.close;
  const lastClosedPrice = liveBarClosed ? live.close : closed.at(-1)!.close;
  const barsAfterPullback = bars.slice(pullback.index);
  const targetReachedIndex = barsAfterPullback.findIndex((bar) => direction === 'bullish'
    ? bar.high >= target
    : bar.low <= target);
  const targetReached = targetReachedIndex >= 0;
  const barsSinceTarget = targetReached ? barsAfterPullback.length - 1 - targetReachedIndex : null;
  if (barsSinceTarget !== null && barsSinceTarget > 6) return null;
  const closedBeyondTrigger = direction === 'bullish'
    ? lastClosedPrice > trigger + currentAtr * 0.05
    : lastClosedPrice < trigger - currentAtr * 0.05;
  const liveTestingTrigger = direction === 'bullish' ? currentPrice >= trigger : currentPrice <= trigger;
  const nearTrigger = Math.abs(currentPrice - trigger) <= currentAtr * 0.25;
  const status: WaveStatus = targetReached
    ? 'target_reached'
    : closedBeyondTrigger
      ? 'active'
      : liveTestingTrigger || nearTrigger ? 'testing' : 'pullback';

  return {
    direction, status, start: start.price, firstEnd: firstEnd.price, pullback: pullback.price,
    trigger, target, invalidation: pullback.price, structureInvalidation: start.price,
    firstLegPoints: height, retracement, barsSincePullback: bars.length - 1 - pullback.index,
    distanceToTrigger: Math.abs(trigger - currentPrice), distanceToTarget: Math.abs(target - currentPrice),
  };
}

function findIslandReversal(bars: Kline[], minimumGap: number) {
  const start = Math.max(1, bars.length - 16);
  for (let left = start; left < bars.length - 2; left += 1) {
    const gapDown = bars[left - 1].low - bars[left].high;
    const gapUp = bars[left].low - bars[left - 1].high;
    for (let right = left + 1; right <= Math.min(left + 5, bars.length - 1); right += 1) {
      const reverseGapUp = bars[right].low - bars[right - 1].high;
      const reverseGapDown = bars[right - 1].low - bars[right].high;
      const islandBars = bars.slice(left, right);
      if (gapDown >= minimumGap && reverseGapUp >= minimumGap) {
        return {
          direction: 'bullish' as const,
          trigger: bars[right].low,
          extreme: Math.min(...islandBars.map((bar) => bar.low)),
          height: Math.max(...islandBars.map((bar) => bar.high)) - Math.min(...islandBars.map((bar) => bar.low)),
          count: islandBars.length,
        };
      }
      if (gapUp >= minimumGap && reverseGapDown >= minimumGap) {
        return {
          direction: 'bearish' as const,
          trigger: bars[right].high,
          extreme: Math.max(...islandBars.map((bar) => bar.high)),
          height: Math.max(...islandBars.map((bar) => bar.high)) - Math.min(...islandBars.map((bar) => bar.low)),
          count: islandBars.length,
        };
      }
    }
  }
  return null;
}

function technicalForm(
  closed: Kline[], live: Kline, previousSupport: number, previousResistance: number,
  closedBreakout: boolean, closedBreakdown: boolean, relativeVolume: number,
): TechnicalPattern {
  const recent = [...closed.slice(-80), live];
  const currentAtr = atr(closed);
  const swingPoints = alternatingPivots(recent, currentAtr);
  const highs = swingPoints.filter((pivot) => pivot.kind === 'high');
  const lows = swingPoints.filter((pivot) => pivot.kind === 'low');
  const lastHighs = highs.slice(-3);
  const lastLows = lows.slice(-3);
  const lastClosed = closed.at(-1)!;
  const rangeHeight = Math.max(previousResistance - previousSupport, 0);
  const volumeText = relativeVolume >= bullishVolumeThreshold
    ? `成交量达到近20根均量的 ${relativeVolume.toFixed(2)} 倍，量能支持这次破线。`
    : `成交量只有近20根均量的 ${relativeVolume.toFixed(2)} 倍，没有达到${bullishVolumeThreshold.toFixed(2)}倍的多头确认标准。`;
  const bearishVolumeText = relativeVolume >= bullishVolumeThreshold
    ? `成交量达到近20根均量的 ${relativeVolume.toFixed(2)} 倍，属于放量跌破，看空强度更高。`
    : `成交量为近20根均量的 ${relativeVolume.toFixed(2)} 倍；空头实体跌破不以放量为必要条件，因此跌破仍成立。`;

  const spring = live.low < previousSupport && live.close > previousSupport;
  if (spring) return {
    name: '破底翻候选', stage: '盘中收回前低，等待实体收盘确认', direction: 'bullish',
    description: `本根最低下探 ${formatPrice(live.low)}，刺破前低 ${formatPrice(previousSupport)} 后收回到 ${formatPrice(live.close)}；目前重新站回前低上方 ${formatPrice(live.close - previousSupport)} 点。扫掉前低后的收回已经出现，但还没有越过区间上沿 ${formatPrice(previousResistance)}，所以只能列为候选。`,
    trigger: previousSupport, target: previousResistance, target2: previousResistance + rangeHeight, invalidation: live.low * 0.99,
  };
  const falseBreakout = live.high > previousResistance && live.close < previousResistance;
  if (falseBreakout) return {
    name: '向上假突破候选', stage: '盘中跌回突破位，等待实体收盘确认', direction: 'bearish',
    description: `本根最高冲到 ${formatPrice(live.high)}，越过前高 ${formatPrice(previousResistance)} 后又收回到 ${formatPrice(live.close)}；现价已重新落在前高下方 ${formatPrice(previousResistance - live.close)} 点。上破没有站稳，但只有再跌破 ${formatPrice(previousSupport)} 才会从假突破演变成明确转弱。`,
    trigger: previousResistance, target: previousSupport, target2: previousSupport - rangeHeight, invalidation: live.high,
  };

  const threeBarBaseline = closed.slice(-23, -3);
  const lastThree = closed.slice(-3);
  if (threeBarBaseline.length >= 15 && lastThree.length === 3) {
    const baselineHigh = Math.max(...threeBarBaseline.map((bar) => bar.high));
    const baselineLow = Math.min(...threeBarBaseline.map((bar) => bar.low));
    const attemptedHigh = Math.max(...lastThree.map((bar) => bar.high));
    const attemptedLow = Math.min(...lastThree.map((bar) => bar.low));
    const failedUpsideBreak = attemptedHigh > baselineHigh && lastClosed.close < baselineHigh;
    if (failedUpsideBreak) return {
      name: '三K内假突破回马枪', stage: '实体跌回突破位，已经确认', direction: 'bearish',
      description: `最近3根K线最高冲到 ${formatPrice(attemptedHigh)}，一度越过原压力 ${formatPrice(baselineHigh)}，但最新实体收回到 ${formatPrice(lastClosed.close)}。假突破在3根K线内完成，现价${pricePosition(live.close, baselineHigh)}；原压力重新成为止损分界。`,
      trigger: baselineHigh, target: baselineLow, target2: baselineLow - (baselineHigh - baselineLow), invalidation: attemptedHigh,
    };
    const reclaimBreakdown = attemptedLow < baselineLow && lastClosed.close > baselineLow;
    const body = Math.abs(lastClosed.close - lastClosed.open);
    const lowerWick = Math.min(lastClosed.open, lastClosed.close) - lastClosed.low;
    if (reclaimBreakdown && (lastClosed.close > lastClosed.open || lowerWick > body * 1.5)) return {
      name: '三K内破底翻', stage: '实体收回前低，已经确认', direction: 'bullish',
      description: `最近3根K线最低下探 ${formatPrice(attemptedLow)}，刺破原支撑 ${formatPrice(baselineLow)} 后，最新实体收回到 ${formatPrice(lastClosed.close)}。收回发生在3根K线内，并出现${lastClosed.close > lastClosed.open ? '阳线实体' : '明显下影线'}，诱空结构成立；新低下方1%为失效位。`,
      trigger: baselineLow, target: baselineHigh, target2: baselineHigh + (baselineHigh - baselineLow), invalidation: attemptedLow * 0.99,
    };
  }

  const island = findIslandReversal(closed, currentAtr * 0.05);
  if (island) {
    const firstTarget = island.direction === 'bullish' ? island.trigger + island.height : island.trigger - island.height;
    const secondTarget = island.direction === 'bullish' ? island.trigger + island.height * 2 : island.trigger - island.height * 2;
    return {
      name: island.direction === 'bullish' ? '向上孤岛转向' : '向下孤岛转向',
      stage: '双缺口已经形成，转向已经确认', direction: island.direction,
      description: `最近出现反向双缺口，中间孤立 ${island.count} 根K线；右侧缺口边界在 ${formatPrice(island.trigger)}，岛形极值在 ${formatPrice(island.extreme)}。BTC为24小时连续交易，真实缺口罕见，因此该信号只在缺口大于0.05 ATR时保留。`,
      trigger: island.trigger, target: firstTarget, target2: secondTarget, invalidation: island.extreme,
    };
  }

  if (lastHighs.length === 3) {
    const [left, head, right] = lastHighs;
    const shouldersSimilar = Math.abs(left.price - right.price) / Math.min(left.price, right.price) <= 0.025;
    if (head.price > Math.max(left.price, right.price) * 1.004 && shouldersSimilar) {
      return headAndShouldersPattern(recent, left, head, right, currentAtr, lastClosed, live, relativeVolume, 'top');
    }
  }
  if (lastLows.length === 3) {
    const [left, head, right] = lastLows;
    const shouldersSimilar = Math.abs(left.price - right.price) / Math.min(left.price, right.price) <= 0.025;
    if (head.price < Math.min(left.price, right.price) * 0.996 && shouldersSimilar) {
      return headAndShouldersPattern(recent, left, head, right, currentAtr, lastClosed, live, relativeVolume, 'bottom');
    }
  }

  const bestBottom = findDoublePatternCandidates(recent, swingPoints, currentAtr, lastClosed, relativeVolume, 'bottom')[0];
  const bestTop = findDoublePatternCandidates(recent, swingPoints, currentAtr, lastClosed, relativeVolume, 'top')[0];
  const bestDouble = [bestBottom, bestTop].filter((candidate): candidate is DoublePatternCandidate => Boolean(candidate))
    .sort((left, right) => right.score - left.score)[0];
  if (bestDouble) {
    const pattern = doublePatternToTechnical(bestDouble, recent, live, relativeVolume);
    const opposing = bestDouble.kind === 'bottom' ? bestTop : bestBottom;
    const opposingIsRelevant = opposing
      && recent.length - 1 - opposing.second.index <= 18
      && Math.abs(live.close - opposing.neckline) <= currentAtr * 2.5;
    if (opposing && opposingIsRelevant && opposing.score < bestDouble.score) {
      pattern.secondary = {
        name: opposing.kind === 'bottom' ? '局部W底候选' : '局部M头候选',
        stage: opposing.priceBroken ? '已经破线，但完整度低于主结构' : '尚未破颈线，不构成反转',
        direction: opposing.kind === 'bottom' ? 'bullish' : 'bearish',
        trigger: opposing.neckline,
      };
    }
    return pattern;
  }

  const poleBars = closed.slice(-28, -14);
  const flagBars = closed.slice(-14);
  if (poleBars.length === 14 && flagBars.length === 14) {
    const poleMove = poleBars.at(-1)!.close - poleBars[0].close;
    const poleHeight = Math.abs(poleMove);
    const flagHigh = Math.max(...flagBars.slice(0, -1).map((bar) => bar.high));
    const flagLow = Math.min(...flagBars.slice(0, -1).map((bar) => bar.low));
    const flagRange = flagHigh - flagLow;
    const highSlope = flagBars.at(-2)!.high - flagBars[0].high;
    const lowSlope = flagBars.at(-2)!.low - flagBars[0].low;
    const poleVolume = average(poleBars.map((bar) => bar.volume));
    const flagVolume = average(flagBars.slice(0, -1).map((bar) => bar.volume));
    const volumeContracted = flagVolume < poleVolume * 0.8;
    const strongPole = poleHeight >= Math.max(currentAtr * 3, poleBars[0].close * 0.03);
    const compactFlag = flagRange <= poleHeight * 0.7;
    if (strongPole && poleMove > 0 && highSlope < 0 && lowSlope < 0 && compactFlag && volumeContracted) {
      const priceBroken = lastClosed.close > flagHigh;
      const confirmed = priceBroken && relativeVolume >= bullishVolumeThreshold;
      return {
        name: '波段下飘旗形', stage: confirmed ? '实体带量突破上轨，已经确认' : priceBroken ? '实体突破但量能不足，未确认' : '旗形缩量整理，等待带量突破', direction: 'bullish',
        description: `前段旗杆上涨 ${formatPrice(poleHeight)} 点，随后14根K线的高低点同步下倾，整理宽度 ${formatPrice(flagRange)} 点，仅占旗杆 ${formatPercent(flagRange / poleHeight)}；整理量缩至旗杆阶段的 ${formatPercent(flagVolume / poleVolume)}。上轨确认位 ${formatPrice(flagHigh)}，${confirmed ? '最新实体带量收上上轨，多头中继成立。' : priceBroken ? `实体已上破，但量能仅 ${relativeVolume.toFixed(2)} 倍，仍按假突破防范。` : `现价还未完成带量上破。`}`,
        trigger: flagHigh, target: flagHigh + poleHeight, target2: flagHigh + poleHeight * 2, invalidation: flagLow,
      };
    }
    if (strongPole && poleMove < 0 && highSlope > 0 && lowSlope > 0 && compactFlag && volumeContracted) {
      const confirmed = lastClosed.close < flagLow;
      return {
        name: '波段上飘旗形', stage: confirmed ? '实体跌破下轨，已经确认' : '旗形无量反弹，等待实体跌破', direction: 'bearish',
        description: `前段旗杆下跌 ${formatPrice(poleHeight)} 点，随后14根K线的高低点同步上倾，反弹宽度 ${formatPrice(flagRange)} 点，仅占旗杆 ${formatPercent(flagRange / poleHeight)}；反弹量缩至旗杆阶段的 ${formatPercent(flagVolume / poleVolume)}。下轨确认位 ${formatPrice(flagLow)}，${confirmed ? `最新实体已收在下轨下方；量能 ${relativeVolume.toFixed(2)} 倍不影响空头中继成立。` : '现价还未实体跌破下轨。'}`,
        trigger: flagLow, target: flagLow - poleHeight, target2: flagLow - poleHeight * 2, invalidation: flagHigh,
      };
    }
  }

  const triangle = findConvergingTriangle(highs, lows, currentAtr, recent.length);
  if (triangle) return convergingTrianglePattern(triangle, currentAtr, lastClosed, live, recent);

  if (closedBreakdown) return {
    name: relativeVolume >= bullishVolumeThreshold ? '放量跌破整理区' : '跌破整理区', stage: '实体收盘跌破，已经确认', direction: 'bearish',
    description: `上一根K线收在 ${formatPrice(closed.at(-1)!.close)}，跌破区间下沿 ${formatPrice(previousSupport)} 共 ${formatPrice(previousSupport - closed.at(-1)!.close)} 点。${bearishVolumeText}当前价${pricePosition(live.close, previousSupport)}，反抽不能收回下沿，跌破才继续有效。`,
    trigger: previousSupport, target: previousSupport - rangeHeight, target2: previousSupport - rangeHeight * 2, invalidation: previousSupport,
  };
  if (closedBreakout) return {
    name: relativeVolume >= bullishVolumeThreshold ? '放量突破整理区' : '无量突破整理区', stage: relativeVolume >= bullishVolumeThreshold ? '实体带量突破，已经确认' : '实体突破但量能不足，未确认', direction: 'bullish',
    description: `上一根K线收在 ${formatPrice(closed.at(-1)!.close)}，突破区间上沿 ${formatPrice(previousResistance)} 共 ${formatPrice(closed.at(-1)!.close - previousResistance)} 点。${volumeText}当前价${pricePosition(live.close, previousResistance)}，回踩守住上沿，突破才继续有效。`,
    trigger: previousResistance, target: previousResistance + rangeHeight, target2: previousResistance + rangeHeight * 2, invalidation: previousResistance,
  };

  const lastRange = Math.max(lastClosed.high - lastClosed.low, 1e-9);
  const lastBody = Math.abs(lastClosed.close - lastClosed.open);
  const nearRangeHigh = lastClosed.high >= previousResistance * 0.995;
  if (relativeVolume >= 2 && nearRangeHigh && lastBody / lastRange <= 0.35 && lastClosed.close <= lastClosed.open * 1.002) {
    const trigger = Math.min(...closed.slice(-5).map((bar) => bar.low));
    return {
      name: '高量滞涨顶候选', stage: '放量不涨，等待实体跌破', direction: 'bearish',
      description: `最新完整K线位于区间高位，成交量达到近20根均量的 ${relativeVolume.toFixed(2)} 倍，但实体仅占整根振幅的 ${formatPercent(lastBody / lastRange)}，价格没有随成交量继续上行，出现高量滞涨。跌破近5根低点 ${formatPrice(trigger)} 后才转为空头确认。`,
      trigger, target: previousSupport, target2: previousSupport - rangeHeight, invalidation: lastClosed.high,
    };
  }
  if (relativeVolume <= 1 / 3 && lastClosed.low <= previousSupport * 1.01) {
    const trigger = Math.max(...closed.slice(-5).map((bar) => bar.high));
    return {
      name: '极度缩量地量底候选', stage: '抛压衰竭，等待带量转强', direction: 'bullish',
      description: `最新完整K线靠近区间低位，成交量仅为近20根均量的 ${relativeVolume.toFixed(2)} 倍，低于1/3地量标准，说明主动抛盘明显减少。但地量不等于立即见底，必须带量越过近5根高点 ${formatPrice(trigger)} 才确认反弹。`,
      trigger, target: previousResistance, target2: previousResistance + rangeHeight, invalidation: lastClosed.low,
    };
  }

  const fanHighs = highs.slice(-4);
  if (fanHighs.length === 4) {
    const fanSlopes = fanHighs.slice(1).map((point, index) =>
      (point.price - fanHighs[index].price) / Math.max(point.index - fanHighs[index].index, 1));
    const flatteningDowntrend = fanSlopes.every((slope) => slope < 0)
      && Math.abs(fanSlopes[2]) < Math.abs(fanSlopes[1])
      && Math.abs(fanSlopes[1]) < Math.abs(fanSlopes[0]);
    if (flatteningDowntrend && lastClosed.close > fanHighs.at(-1)!.price && relativeVolume >= bullishVolumeThreshold) {
      const lineHeight = fanHighs[0].price - fanHighs.at(-1)!.price;
      return {
        name: '扇形第三切线突破候选', stage: '算法候选，必须人工复核切线', direction: 'bullish',
        description: `最近4个反弹高点依次降低，但下降斜率连续放缓；最新实体以 ${relativeVolume.toFixed(2)} 倍均量越过最近切线参考点 ${formatPrice(fanHighs.at(-1)!.price)}。算法只能验证斜率与破线，无法替代人工画出三条切线，因此不自动标记为最终确认。`,
        trigger: fanHighs.at(-1)!.price, target: fanHighs.at(-1)!.price + lineHeight, target2: fanHighs.at(-1)!.price + lineHeight * 2,
        invalidation: lastLows.at(-1)?.price ?? previousSupport,
      };
    }
  }

  if (lastHighs.length >= 2 && lastLows.length >= 2) {
    const structureNoise = currentAtr * 0.25;
    const highChange = lastHighs.at(-1)!.price - lastHighs.at(-2)!.price;
    const lowChange = lastLows.at(-1)!.price - lastLows.at(-2)!.price;
    const highFalling = highChange < -structureNoise;
    const lowFalling = lowChange < -structureNoise;
    const highRising = highChange > structureNoise;
    const lowRising = lowChange > structureNoise;
    if (highFalling && lowFalling) return {
      name: '下降结构', stage: live.close < lastLows.at(-1)!.price ? '跌破前低，已经确认' : '结构成立，等待续破前低', direction: 'bearish',
      description: `反弹高点从 ${formatPrice(lastHighs.at(-2)!.price)} 降到 ${formatPrice(lastHighs.at(-1)!.price)}，回落低点也从 ${formatPrice(lastLows.at(-2)!.price)} 降到 ${formatPrice(lastLows.at(-1)!.price)}。当前价${pricePosition(live.close, lastLows.at(-1)!.price)}；${live.close < lastLows.at(-1)!.price ? '已经续破最近低点，下降结构延续。' : `重新跌破 ${formatPrice(lastLows.at(-1)!.price)} 才会确认下一段下行。`}`,
      trigger: lastLows.at(-1)!.price, target: null, target2: null, invalidation: lastHighs.at(-1)!.price,
    };
    if (highRising && lowRising) return {
      name: '上升结构', stage: live.close > lastHighs.at(-1)!.price ? '突破前高，已经确认' : '结构成立，等待续破前高', direction: 'bullish',
      description: `上冲高点从 ${formatPrice(lastHighs.at(-2)!.price)} 抬到 ${formatPrice(lastHighs.at(-1)!.price)}，回落低点也从 ${formatPrice(lastLows.at(-2)!.price)} 抬到 ${formatPrice(lastLows.at(-1)!.price)}。当前价${pricePosition(live.close, lastHighs.at(-1)!.price)}；${live.close > lastHighs.at(-1)!.price ? '已经续破最近高点，上升结构延续。' : `重新突破 ${formatPrice(lastHighs.at(-1)!.price)} 才会确认下一段上行。`}`,
      trigger: lastHighs.at(-1)!.price, target: null, target2: null, invalidation: lastLows.at(-1)!.price,
    };
    if (highFalling && lowRising) return {
      name: '收敛三角形', stage: '整理中，等待选择方向', direction: 'neutral',
      description: `上沿从 ${formatPrice(lastHighs.at(-2)!.price)} 压低到 ${formatPrice(lastHighs.at(-1)!.price)}，下沿从 ${formatPrice(lastLows.at(-2)!.price)} 抬高到 ${formatPrice(lastLows.at(-1)!.price)}，最新收敛区间是 ${formatPrice(lastLows.at(-1)!.price)}–${formatPrice(lastHighs.at(-1)!.price)}。现价在区间内，向任何一边破线前都没有方向。`,
      trigger: null, target: null, target2: null, invalidation: null,
    };
  }
  return {
    name: '区间整理', stage: '方向未确认', direction: 'neutral',
    description: `最近20根K线主要在 ${formatPrice(previousSupport)}–${formatPrice(previousResistance)} 之间运行，当前价 ${formatPrice(live.close)}，距离下沿 ${formatPrice(live.close - previousSupport)} 点、距离上沿 ${formatPrice(previousResistance - live.close)} 点。高低点顺序尚未形成趋势，靠近区间中部没有明确方向。`,
    trigger: previousResistance, target: null, target2: null, invalidation: previousSupport,
  };
}

function calculatePattern(pattern: TechnicalPattern): PatternCalculation {
  const calculable = pattern.direction !== 'neutral' && pattern.trigger !== null && pattern.target !== null;
  if (!calculable || pattern.trigger === null || pattern.target === null) {
    return {
      calculable: false,
      active: false,
      method: pattern.name.includes('收敛三角形')
        ? '等待实体选择突破方向后，再按三角形最宽高度投射'
        : '当前结构没有可靠的固定涨跌幅，不强行计算目标',
      height: null,
      formulaT1: null,
      formulaT2: null,
    };
  }

  const method = pattern.name.includes('收敛三角形')
    ? '突破线加减三角形最宽高度'
    : pattern.name.includes('头肩')
      ? '头部日期量高度，再从突破日期的斜颈线投射'
      : pattern.name === 'W底' || pattern.name === 'M头'
        ? '颈线加减形态高度'
    : pattern.name.includes('旗形')
      ? '突破线加减前一段旗杆长度'
      : pattern.name.includes('整理区')
        ? '突破线加减原整理区高度'
        : pattern.name.includes('孤岛')
          ? '缺口边界加减岛形高度'
          : pattern.name.includes('扇形')
            ? '突破线加减切线落差'
            : pattern.name.includes('破底翻') || pattern.name.includes('假突破')
              || pattern.name.includes('滞涨') || pattern.name.includes('地量')
              ? '先看原整理区另一侧，再投射一倍区间高度'
              : '按关键线到第一目标的结构距离投射';
  const sign = pattern.direction === 'bullish' ? '+' : '-';
  const height = Math.abs(pattern.target - pattern.trigger);
  const secondHeight = pattern.target2 === null ? null : Math.abs(pattern.target2 - pattern.trigger);
  return {
    calculable: true,
    active: isPatternConfirmed(pattern.stage),
    method,
    height,
    formulaT1: `${formatPrice(pattern.trigger)} ${sign} ${formatPrice(height)} = ${formatPrice(pattern.target)}`,
    formulaT2: pattern.target2 === null || secondHeight === null
      ? null
      : `${formatPrice(pattern.trigger)} ${sign} ${formatPrice(secondHeight)} = ${formatPrice(pattern.target2)}`,
  };
}

function broaderStructureConflict(closed: Kline[], live: Kline, direction: Direction, relativeVolume: number): StructureContext | null {
  if (direction === 'neutral') return null;
  const recent = [...closed.slice(-80), live];
  const currentAtr = atr(closed);
  const swingPoints = alternatingPivots(recent, currentAtr);
  const highs = swingPoints.filter((pivot) => pivot.kind === 'high');
  const lows = swingPoints.filter((pivot) => pivot.kind === 'low');
  const lastClosed = closed.at(-1)!;
  if (direction === 'bullish') {
    const confirmedTop = findDoublePatternCandidates(recent, swingPoints, currentAtr, lastClosed, relativeVolume, 'top')
      .find((candidate) => candidate.confirmed);
    if (confirmedTop) {
      const target = confirmedTop.neckline - confirmedTop.height;
      return {
        pattern: '已确认M头', direction: 'bearish', keyLevel: confirmedTop.neckline, target,
        text: `更大周期的M头还在：双顶 ${formatPrice(confirmedTop.first.price)}/${formatPrice(confirmedTop.second.price)}，颈线 ${formatPrice(confirmedTop.neckline)}，下跌目标约 ${formatPrice(target)}。价格没有实体收回 ${formatPrice(confirmedTop.neckline)} 前，这次上涨只算反弹，不算反转。`,
      };
    }
    const lastHighs = highs.slice(-2);
    const lastLows = lows.slice(-2);
    if (lastHighs.length === 2 && lastLows.length === 2
      && lastHighs[1].price < lastHighs[0].price && lastLows[1].price < lastLows[0].price) {
      return {
        pattern: '下降序列', direction: 'bearish', keyLevel: lastHighs[1].price, target: null,
        text: `更大结构仍是下降序列：反弹高点从 ${formatPrice(lastHighs[0].price)} 降到 ${formatPrice(lastHighs[1].price)}，低点从 ${formatPrice(lastLows[0].price)} 降到 ${formatPrice(lastLows[1].price)}。当前底部信号属于逆势反转，先看能否突破最近反弹高点。`,
      };
    }
  }
  if (direction === 'bearish') {
    const confirmedBottom = findDoublePatternCandidates(recent, swingPoints, currentAtr, lastClosed, relativeVolume, 'bottom')
      .find((candidate) => candidate.confirmed);
    if (confirmedBottom) {
      const target = confirmedBottom.neckline + confirmedBottom.height;
      return {
        pattern: '已确认W底', direction: 'bullish', keyLevel: confirmedBottom.neckline, target,
        text: `更大周期的W底还在：双底 ${formatPrice(confirmedBottom.first.price)}/${formatPrice(confirmedBottom.second.price)}，颈线 ${formatPrice(confirmedBottom.neckline)}，上涨目标约 ${formatPrice(target)}。价格没有实体跌回 ${formatPrice(confirmedBottom.neckline)} 下方前，这次下跌只算回调，不算转空。`,
      };
    }
    const lastHighs = highs.slice(-2);
    const lastLows = lows.slice(-2);
    if (lastHighs.length === 2 && lastLows.length === 2
      && lastHighs[1].price > lastHighs[0].price && lastLows[1].price > lastLows[0].price) {
      return {
        pattern: '上升序列', direction: 'bullish', keyLevel: lastLows[1].price, target: null,
        text: `更大结构仍是上升序列：高点从 ${formatPrice(lastHighs[0].price)} 抬到 ${formatPrice(lastHighs[1].price)}，回落低点从 ${formatPrice(lastLows[0].price)} 抬到 ${formatPrice(lastLows[1].price)}。当前顶部信号属于逆势回落，先看最近抬高低点是否被实体跌破。`,
      };
    }
  }
  return null;
}

function analyzeInterval(interval: Interval, rows: RawKline[], now: number, futuresLive?: FuturesKline, indicatorDataReliable = true) {
  const klines: Kline[] = rows.map((row) => ({
    openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]),
  }));
  const spotLive = klines.at(-1)!;
  const live: Kline = futuresLive ? {
    openTime: futuresLive.openTime, closeTime: futuresLive.closeTime, open: futuresLive.open,
    high: futuresLive.high, low: futuresLive.low, close: futuresLive.close, volume: futuresLive.volume,
  } : spotLive;
  const closed = klines.filter((bar) => bar.closeTime <= now);
  const lastClosed = closed.at(-1)!;
  const closedCloses = closed.map((bar) => bar.close);
  const closes = live.openTime > lastClosed.openTime
    ? [...closedCloses, live.close]
    : [...closedCloses.slice(0, -1), live.close];
  const liveBarClosed = futuresLive?.closed ?? live.closeTime <= now;
  const ema20 = ema(closes, 20).at(-1) ?? lastClosed.close;
  const ema60 = ema(closes, 60).at(-1) ?? lastClosed.close;
  const ema12Values = ema(closes, 12);
  const ema26Values = ema(closes, 26);
  const macdValues = closes.map((_, index) => ema12Values[index] - ema26Values[index]);
  const signalValues = ema(macdValues, 9);
  const histogram = macdValues.map((value, index) => value - signalValues[index]);
  const previousBars = closed.slice(-21, -1);
  const levelBars = closed.slice(-20);
  const resistance20 = Math.max(...levelBars.map((bar) => bar.high));
  const support20 = Math.min(...levelBars.map((bar) => bar.low));
  const previousResistance = Math.max(...previousBars.map((bar) => bar.high));
  const previousSupport = Math.min(...previousBars.map((bar) => bar.low));
  const relativeVolume = lastClosed.volume / Math.max(average(previousBars.map((bar) => bar.volume)), 1e-9);
  const closedBreakout = lastClosed.close > previousResistance;
  const closedBreakdown = lastClosed.close < previousSupport;
  const currentRsi = rsi(closes);
  const closedRsi = liveBarClosed ? currentRsi : rsi(closedCloses);
  const currentHistogram = histogram.at(-1) ?? 0;
  const previousHistogram = histogram.at(-2) ?? currentHistogram;
  let score = 0;
  if (indicatorDataReliable) {
    score += live.close > ema20 ? 1 : -1;
    score += ema20 > ema60 ? 1 : -1;
    score += currentHistogram > 0 ? 1 : -1;
    score += currentHistogram > previousHistogram ? 0.5 : -0.5;
    score += currentRsi > 55 ? 1 : currentRsi < 45 ? -1 : 0;
  }
  if (closedBreakout && relativeVolume >= bullishVolumeThreshold) score += 2;
  if (closedBreakdown) score -= relativeVolume >= bullishVolumeThreshold ? 2.5 : 2;
  const bias = score >= 2.5 ? 'bullish' : score <= -2.5 ? 'bearish' : 'neutral';
  const biasLabel = bias === 'bullish' ? '偏多' : bias === 'bearish' ? '偏空' : '震荡';
  const breakoutState = closedBreakout
    ? relativeVolume >= bullishVolumeThreshold ? '实体带量突破已确认' : '实体突破但量能不足，按假突破防范'
    : closedBreakdown
      ? relativeVolume >= bullishVolumeThreshold ? '放量实体跌破，强看空确认' : '实体跌破已确认，量能不影响空头成立'
      : live.close > resistance20 ? '盘中突破，等待收盘确认'
        : live.close < support20 ? '盘中跌破，等待收盘确认' : '未突破关键区间';
  const pattern = technicalForm(closed, live, previousSupport, previousResistance, closedBreakout, closedBreakdown, relativeVolume);
  const patternCalculation = calculatePattern(pattern);
  const broaderContext = broaderStructureConflict(closed, live, pattern.direction, relativeVolume);
  const contextWarning = broaderContext?.text ?? null;
  const recentClosed = closed.slice(-80);
  const pivotOffset = closed.length - recentClosed.length;
  const recentPivots = pivots(recentClosed);
  const lowPair = recentPivots.filter((pivot) => pivot.kind === 'low').slice(-2);
  const highPair = recentPivots.filter((pivot) => pivot.kind === 'high').slice(-2);
  const macdAtPivot = (pivot: Pivot) => macdValues[pivotOffset + pivot.index] ?? 0;
  const bullishDivergence = lowPair.length === 2
    && lowPair[1].price <= lowPair[0].price * 1.003
    && macdAtPivot(lowPair[1]) > macdAtPivot(lowPair[0]);
  const bearishDivergence = highPair.length === 2
    && highPair[1].price >= highPair[0].price * 0.997
    && macdAtPivot(highPair[1]) < macdAtPivot(highPair[0]);
  const trendConfirmed = indicatorDataReliable && (pattern.direction === 'bullish'
    ? live.close > ema20 && ema20 > ema60
    : pattern.direction === 'bearish' ? live.close < ema20 && ema20 < ema60 : false);
  const macdLiveDirectionConfirmed = pattern.direction === 'bullish'
    ? (macdValues.at(-1) ?? 0) > (signalValues.at(-1) ?? 0) && currentHistogram - previousHistogram > 0
    : pattern.direction === 'bearish'
      ? (macdValues.at(-1) ?? 0) < (signalValues.at(-1) ?? 0) && currentHistogram - previousHistogram < 0 : false;
  const previousMacdLine = macdValues.at(-2) ?? 0;
  const previousMacdSignal = signalValues.at(-2) ?? 0;
  const priorHistogram = histogram.at(-3) ?? previousHistogram;
  const macdClosedDirectionConfirmed = pattern.direction === 'bullish'
    ? previousMacdLine > previousMacdSignal && previousHistogram - priorHistogram > 0
    : pattern.direction === 'bearish'
      ? previousMacdLine < previousMacdSignal && previousHistogram - priorHistogram < 0 : false;
  const bullishDivergenceConfirmed = bullishDivergence && previousHistogram - priorHistogram > 0;
  const bearishDivergenceConfirmed = bearishDivergence && previousHistogram - priorHistogram < 0;
  const macdConfirmed = indicatorDataReliable && (macdClosedDirectionConfirmed
    || (pattern.direction === 'bullish' && bullishDivergenceConfirmed)
    || (pattern.direction === 'bearish' && bearishDivergenceConfirmed));
  const macdProvisional = indicatorDataReliable && !liveBarClosed && !macdConfirmed
    && (macdLiveDirectionConfirmed
      || (pattern.direction === 'bullish' && bullishDivergence && currentHistogram - previousHistogram > 0)
      || (pattern.direction === 'bearish' && bearishDivergence && currentHistogram - previousHistogram < 0));
  const rsiConfirmed = indicatorDataReliable && (pattern.direction === 'bullish' ? currentRsi > 50 : pattern.direction === 'bearish' ? currentRsi < 50 : false);
  const volumeConfirmed = indicatorDataReliable && (pattern.direction === 'bullish'
    ? relativeVolume >= bullishVolumeThreshold
    : pattern.direction === 'bearish');
  const confirmationCount = [trendConfirmed, macdConfirmed, rsiConfirmed, volumeConfirmed].filter(Boolean).length;
  const macdLine = macdValues.at(-1) ?? 0;
  const macdSignal = signalValues.at(-1) ?? 0;
  const macdZone = macdLine >= 0 ? '零轴上方（水上）' : '零轴下方（水下）';
  const crossedUpNow = previousMacdLine <= previousMacdSignal && macdLine > macdSignal;
  const crossedDownNow = previousMacdLine >= previousMacdSignal && macdLine < macdSignal;
  const macdCross = macdLine > macdSignal
    ? crossedUpNow ? '刚形成金叉' : '金叉状态'
    : crossedDownNow ? '刚形成死叉' : '死叉状态';
  const histogramState = previousHistogram <= 0 && currentHistogram > 0
    ? '柱体由负转正'
    : previousHistogram >= 0 && currentHistogram < 0
      ? '柱体由正转负'
      : currentHistogram - previousHistogram > 0 ? '动能比上一根增强' : '动能比上一根减弱';
  const closedMacdCross = previousMacdLine > previousMacdSignal ? '金叉' : '死叉';
  const crossTimingText = liveBarClosed
    ? `，本根${intervalLabels[interval]}K线已经收盘`
    : crossedUpNow
      ? `，金叉发生在当前${intervalLabels[interval]}K线盘中，尚未收盘确认`
      : crossedDownNow
        ? `，死叉发生在当前${intervalLabels[interval]}K线盘中，尚未收盘确认`
        : `，上一根完整${intervalLabels[interval]}K线已处于${closedMacdCross}，当前K线尚未收盘`;
  const trendText = !indicatorDataReliable
    ? '合约历史K线暂不可用，均线方向暂停判断'
    : pattern.direction === 'bullish'
    ? live.close > ema20 && ema20 > ema60
      ? '现价在20周期线上方，且20周期线高于60周期线，多头排列已经形成'
      : live.close > ema20
        ? '现价虽回到20周期线上方，但20周期线仍低于60周期线，只能算反弹，趋势尚未翻多'
        : '现价仍在20周期线下方，趋势没有支持上涨形态'
    : pattern.direction === 'bearish'
      ? live.close < ema20 && ema20 < ema60
        ? '现价在20周期线下方，且20周期线低于60周期线，空头排列仍完整'
        : live.close < ema20
          ? '现价跌到20周期线下方，但20周期线仍高于60周期线，只能算回落，趋势尚未翻空'
          : '现价仍在20周期线上方，趋势没有支持下跌形态'
      : '均线没有与一个明确的突破方向绑定，暂不作为确认项';
  const macdText = !indicatorDataReliable
    ? '合约历史K线暂不可用，MACD金叉、死叉和背离暂停判断'
    : pattern.direction === 'bullish' && bullishDivergence
    ? `价格第二个低点没有明显抬高，但MACD低点已经抬高，出现底背离；当前为${macdZone}${macdCross}，${histogramState}${crossTimingText}，${macdConfirmed ? '背离已由完整K线确认' : macdProvisional ? '盘中转强，等待收盘' : '背离尚未确认'}`
    : pattern.direction === 'bearish' && bearishDivergence
      ? `价格第二个高点没有明显降低，但MACD高点已经降低，出现顶背离；当前为${macdZone}${macdCross}，${histogramState}${crossTimingText}，${macdConfirmed ? '背离已由完整K线确认' : macdProvisional ? '盘中转弱，等待收盘' : '背离尚未确认'}`
      : pattern.direction === 'neutral'
        ? `MACD当前为${macdZone}${macdCross}，${histogramState}${crossTimingText}`
        : `MACD当前为${macdZone}${macdCross}，${histogramState}${crossTimingText}，${macdConfirmed ? '上一根完整K线已支持当前形态' : macdProvisional ? '当前只算盘中支持，等待收盘' : '暂未支持当前形态'}`;
  const rsiText = !indicatorDataReliable
    ? '合约历史K线暂不可用，RSI强弱暂停判断'
    : pattern.direction === 'bullish'
    ? `RSI为 ${currentRsi.toFixed(1)}，${currentRsi > 50 ? '已站上50强弱分界，买方暂时占优' : '仍低于50，买方尚未取得强弱优势'}`
    : pattern.direction === 'bearish'
      ? `RSI为 ${currentRsi.toFixed(1)}，${currentRsi < 50 ? '位于50下方，卖方暂时占优' : '仍在50上方，卖方尚未取得强弱优势'}`
      : `RSI为 ${currentRsi.toFixed(1)}，区间未破前只反映短线强弱，不确认方向`;
  const volumeCheckText = !indicatorDataReliable
    ? '合约历史K线暂不可用，量价关系暂停判断'
    : pattern.direction === 'bullish'
    ? `最近一根完整K线成交量是近20根均量的 ${relativeVolume.toFixed(2)} 倍，${volumeConfirmed ? `达到${bullishVolumeThreshold.toFixed(2)}倍多头确认标准` : `没有达到${bullishVolumeThreshold.toFixed(2)}倍多头确认标准，无量上破按假突破防范`}`
    : pattern.direction === 'bearish'
      ? `最近一根完整K线成交量是近20根均量的 ${relativeVolume.toFixed(2)} 倍；空头实体跌破不强制放量，${relativeVolume >= bullishVolumeThreshold ? '当前放量使看空信号更强' : '当前量能不否决跌破'} `
      : `最近一根完整K线成交量是近20根均量的 ${relativeVolume.toFixed(2)} 倍，形态未选方向，量能暂不确认多空`;
  const indicatorChecks = [
    { name: '趋势方向', confirmed: trendConfirmed, provisional: false, available: indicatorDataReliable, text: trendText },
    { name: 'MACD动能', confirmed: macdConfirmed, provisional: macdProvisional, available: indicatorDataReliable, text: macdText },
    { name: 'RSI强弱', confirmed: rsiConfirmed, provisional: false, available: indicatorDataReliable, text: rsiText },
    { name: '量价关系', confirmed: volumeConfirmed, provisional: false, available: indicatorDataReliable, text: volumeCheckText.trim() },
  ];
  const provisionalCount = indicatorChecks.filter((check) => check.provisional).length;
  const indicatorSummary = pattern.direction === 'neutral'
    ? `指标验证：${indicatorChecks.map((check) => check.text).join('；')}。形态没有选择方向，当前不计算通过票数。`
    : `指标验证：${indicatorChecks.map((check) => check.text).join('；')}。合计 ${confirmationCount}/4 项已收盘支持${pattern.name}${provisionalCount ? `，另有 ${provisionalCount} 项盘中支持` : ''}，${confirmationCount >= 3 ? '达到确认要求' : '未达到确认要求'}。`;
  const currentAtr = atr(closed);
  const describeWave = (direction: 'bullish' | 'bearish') => {
    const wave = detectSecondLeg(closed, live, currentAtr, direction, liveBarClosed);
    if (!wave) return null;
    const priceConfirmed = wave.status === 'active' || wave.status === 'target_reached';
    const priceProvisional = wave.status === 'testing';
    const confirmedHistogram = liveBarClosed ? currentHistogram : previousHistogram;
    const precedingConfirmedHistogram = liveBarClosed ? previousHistogram : priorHistogram;
    const macdDirectionConfirmed = indicatorDataReliable && (direction === 'bullish'
      ? confirmedHistogram > 0 && confirmedHistogram > precedingConfirmedHistogram
      : confirmedHistogram < 0 && confirmedHistogram < precedingConfirmedHistogram);
    const macdDirectionProvisional = indicatorDataReliable && !liveBarClosed && !macdDirectionConfirmed
      && (direction === 'bullish'
        ? currentHistogram > 0 && currentHistogram > previousHistogram
        : currentHistogram < 0 && currentHistogram < previousHistogram);
    const rsiDirectionConfirmed = indicatorDataReliable && (direction === 'bullish' ? closedRsi > 50 : closedRsi < 50);
    const rsiDirectionProvisional = indicatorDataReliable && !liveBarClosed && !rsiDirectionConfirmed
      && (direction === 'bullish' ? currentRsi > 50 : currentRsi < 50);
    const volumeDirectionConfirmed = indicatorDataReliable && relativeVolume >= bullishVolumeThreshold;
    const checks = [
      {
        name: '价格破位', confirmed: priceConfirmed, provisional: priceProvisional,
        text: priceConfirmed
          ? `完整K线已经${direction === 'bullish' ? '站上' : '跌破'}第一段终点 ${formatPrice(wave.trigger)}`
          : priceProvisional
            ? `正在测试第一段终点 ${formatPrice(wave.trigger)}，等待实体收盘`
            : `距离启动线 ${formatPrice(wave.trigger)} 还有 ${formatPrice(wave.distanceToTrigger)} 点`,
      },
      {
        name: 'MACD动能', confirmed: macdDirectionConfirmed, provisional: macdDirectionProvisional,
        text: macdDirectionConfirmed
          ? `上一根完整K线的MACD柱体与${direction === 'bullish' ? '上涨' : '下跌'}方向同步增强`
          : macdDirectionProvisional
            ? `当前K线的MACD柱体盘中转${direction === 'bullish' ? '强' : '弱'}，等待收盘确认`
            : `完整K线的MACD柱体没有与${direction === 'bullish' ? '上涨' : '下跌'}方向同步增强`,
      },
      {
        name: 'RSI强弱', confirmed: rsiDirectionConfirmed, provisional: rsiDirectionProvisional,
        text: rsiDirectionConfirmed
          ? `上一根完整K线RSI ${closedRsi.toFixed(1)}，方向支持`
          : rsiDirectionProvisional
            ? `当前K线RSI ${currentRsi.toFixed(1)} 盘中支持，等待收盘确认`
            : `上一根完整K线RSI ${closedRsi.toFixed(1)}，方向不支持`,
      },
      {
        name: '突破量能', confirmed: volumeDirectionConfirmed, provisional: false,
        text: `成交量为20根均量的 ${relativeVolume.toFixed(2)} 倍，${volumeDirectionConfirmed ? '达到确认标准' : `未达到 ${bullishVolumeThreshold.toFixed(2)} 倍标准`}`,
      },
    ];
    const confirmedCount = checks.filter((check) => check.confirmed).length;
    const statusLabel = wave.status === 'target_reached' ? '等幅目标已经到达'
      : wave.status === 'active' ? '第二段已经启动'
        : wave.status === 'testing' ? '正在测试启动线' : '回踩中，第二段尚未启动';
    const qualified = priceConfirmed && confirmedCount >= 3;
    const nextAction = wave.status === 'target_reached'
      ? `目标 ${formatPrice(wave.target)} 已经兑现，不能继续把它当成新的追价理由。`
      : wave.status === 'active'
        ? qualified
          ? `价格和至少3项条件已经确认，等幅目标看 ${formatPrice(wave.target)}；回到 ${formatPrice(wave.trigger)} 下方则降级。`
          : `价格虽然破线，但只有 ${confirmedCount}/4 项确认，先防假突破，不把 ${formatPrice(wave.target)} 当成必到价。`
        : wave.status === 'testing'
          ? `实体收盘${direction === 'bullish' ? '站上' : '跌破'} ${formatPrice(wave.trigger)} 后才算启动；盘中刺破不算。`
          : `${direction === 'bullish' ? '回踩' : '反抽'}点 ${formatPrice(wave.pullback)} 尚未失效，但必须先${direction === 'bullish' ? '突破' : '跌破'} ${formatPrice(wave.trigger)}。`;
    return {
      ...wave, statusLabel, qualified, confirmationCount, checks, nextAction,
      formula: direction === 'bullish'
        ? `${formatPrice(wave.pullback)} + (${formatPrice(wave.firstEnd)} - ${formatPrice(wave.start)}) = ${formatPrice(wave.target)}`
        : `${formatPrice(wave.pullback)} - (${formatPrice(wave.start)} - ${formatPrice(wave.firstEnd)}) = ${formatPrice(wave.target)}`,
    };
  };
  const secondLeg = { bullish: describeWave('bullish'), bearish: describeWave('bearish') };
  return {
    interval, label: intervalLabels[interval], bias, biasLabel, score,
    livePrice: live.close, liveOpen: live.open, liveHigh: live.high, liveLow: live.low,
    liveBarClosed, lastClosedTime: lastClosed.closeTime,
    ema20, ema60, rsi14: currentRsi, atr14: currentAtr,
    macd: macdValues.at(-1) ?? 0, macdSignal: signalValues.at(-1) ?? 0,
    macdHistogram: currentHistogram, macdPreviousHistogram: previousHistogram,
    macdHistogramChange: currentHistogram - previousHistogram,
    macdCross: macdLine > macdSignal ? 'golden' : 'death',
    macdCrossTiming: crossedUpNow || crossedDownNow ? (liveBarClosed ? 'closed' : 'intrabar') : 'existing',
    macdPreviousClosedCross: previousMacdLine > previousMacdSignal ? 'golden' : 'death',
    relativeVolume, support20, resistance20, previousSupport, previousResistance,
    closedBreakout, closedBreakdown, breakoutState,
    technicalForm: pattern,
    patternCalculation,
    contextWarning,
    contextPattern: broaderContext?.pattern ?? null,
    contextLevel: broaderContext?.keyLevel ?? null,
    contextTarget: broaderContext?.target ?? null,
    indicatorSummary,
    indicatorConfirmation: {
      count: confirmationCount, provisionalCount,
      level: confirmationCount >= 4 ? '指标强确认' : confirmationCount >= 3 ? '指标基本确认' : '指标确认不足',
      checks: indicatorChecks,
    },
    secondLeg,
    change1: lastClosed.close / closed.at(-2)!.close - 1,
  };
}

function uniqueLevels(values: number[], currentPrice: number, direction: 'support' | 'resistance') {
  const ordered = values
    .filter((value) => direction === 'support' ? value < currentPrice : value > currentPrice)
    .sort((left, right) => direction === 'support' ? right - left : left - right);
  return ordered.filter((value, index, items) => index === 0 || Math.abs(value / items[index - 1] - 1) > 0.0025).slice(0, 4);
}

function isPatternConfirmed(stage: string) {
  return stage.includes('已经确认') || stage.includes('已确认');
}

async function fetchHistoricalKlines(interval: Interval) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=300`;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error(`Binance ${interval} request failed: ${response.status}`);
      return await response.json() as RawKline[];
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Binance historical request failed');
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error(`Binance ${interval} request failed`);
}

export async function GET() {
  try {
    const [historyResult, futures] = await Promise.all([
      getBinanceFuturesHistory(intervals).then((history) => ({
        rows: history.rows as Array<readonly [Interval, RawKline[]]>,
        reliable: true,
        source: history.source,
      })).catch(async (binanceError) => {
        console.error('Binance futures history unavailable:', binanceError);
        return getTradingViewHistory().then((history) => ({
          rows: intervals.map((interval) => [interval, history[interval] as RawKline[]] as const),
          reliable: true,
          source: 'TradingView · BINANCE:BTCUSDT.P 永续合约K线（灾备）',
        })).catch(async (tradingViewError) => {
          console.error('TradingView futures history unavailable:', tradingViewError);
          return {
            rows: await Promise.all(intervals.map(async (interval) => [interval, await fetchHistoricalKlines(interval)] as const)),
            reliable: false,
            source: 'Binance Spot K线（合约历史暂不可用，指标判断已暂停）',
          };
        });
      }),
      Promise.any([getFuturesSnapshot(), getBinanceFuturesQuote()]).catch(() => null),
    ]);
    const { rows, reliable: indicatorDataReliable, source: historySource } = historyResult;
    const now = Date.now();
    const liveKlines = futures && 'klines' in futures ? futures.klines : futures && 'source' in futures
      ? Object.fromEntries(intervals.map((interval) => {
        const row = rows.find(([name]) => name === interval)?.[1].at(-1);
        const close = futures.lastPrice;
        return [interval, row ? {
          interval, openTime: Number(row[0]), closeTime: Number(row[6]), open: Number(row[1]),
          high: Math.max(Number(row[2]), close), low: Math.min(Number(row[3]), close), close,
          volume: Number(row[5]), closed: false,
        } : undefined];
      })) as Partial<Record<Interval, FuturesKline>> : undefined;
    const analyses = Object.fromEntries(rows.map(([interval, data]) => [
      interval, analyzeInterval(interval, data, now, liveKlines?.[interval], indicatorDataReliable),
    ])) as Record<Interval, ReturnType<typeof analyzeInterval>>;
    const currentPrice = futures?.lastPrice ?? analyses['15m'].livePrice;
    const weightedScore = intervals.reduce((total, interval) => total + Math.sign(analyses[interval].score) * intervalWeights[interval], 0);
    const overallBias = weightedScore >= 4 ? 'bullish' : weightedScore <= -4 ? 'bearish' : 'neutral';
    const overallLabel = overallBias === 'bullish' ? '多周期偏多' : overallBias === 'bearish' ? '多周期偏空' : '多周期震荡';
    const allLevels = intervals.flatMap((interval) => [analyses[interval].support20, analyses[interval].resistance20]);
    const supports = uniqueLevels(allLevels, currentPrice, 'support');
    const resistances = uniqueLevels(allLevels, currentPrice, 'resistance');
    const confirmedBreakdowns = intervals.filter((interval) => analyses[interval].closedBreakdown);
    const confirmedBreakouts = intervals.filter((interval) => analyses[interval].closedBreakout && analyses[interval].relativeVolume >= bullishVolumeThreshold);
    const measuredSource = [...intervals].reverse().find((interval) => analyses[interval].closedBreakdown);
    const measuredTarget = measuredSource
      ? analyses[measuredSource].previousSupport - (analyses[measuredSource].previousResistance - analyses[measuredSource].previousSupport)
      : null;
    const preferredIntervals: Interval[] = ['1d', '4h', '1h', '15m'];
    const primaryInterval = preferredIntervals.find((interval) => {
      const form = analyses[interval].technicalForm;
      return form.direction === overallBias && isPatternConfirmed(form.stage);
    }) ?? preferredIntervals.find((interval) => isPatternConfirmed(analyses[interval].technicalForm.stage)) ?? '4h';
    const primary = analyses[primaryInterval];
    const primaryForm = primary.technicalForm;
    const directionSign = primaryForm.direction === 'bullish' ? 1 : primaryForm.direction === 'bearish' ? -1 : 0;
    const trigger = primaryForm.trigger;
    const confirmationPrice = trigger === null || directionSign === 0 ? null : trigger + directionSign * primary.atr14 * 0.10;
    const retestZone = trigger === null ? null : primaryForm.direction === 'bullish'
      ? { low: trigger, high: trigger + primary.atr14 * 0.25 }
      : primaryForm.direction === 'bearish' ? { low: trigger - primary.atr14 * 0.25, high: trigger } : null;
    const shapeConfirmed = isPatternConfirmed(primaryForm.stage);
    const indicatorsConfirmed = primary.indicatorConfirmation.count >= 3;
    const farFromTrigger = confirmationPrice === null ? false : Math.abs(currentPrice - confirmationPrice) > primary.atr14 * 0.75;
    const missingIndicators = primary.indicatorConfirmation.checks.filter((check) => !check.confirmed).map((check) => check.name);
    const confirmationDistance = confirmationPrice === null ? null : Math.abs(currentPrice - confirmationPrice);
    const confirmationDistancePercent = confirmationPrice === null ? null : confirmationDistance! / confirmationPrice;
    const movementWord = primaryForm.direction === 'bullish' ? '上涨' : primaryForm.direction === 'bearish' ? '下跌' : '移动';
    const targetReached = primaryForm.target !== null && (primaryForm.direction === 'bullish'
      ? currentPrice >= primaryForm.target
      : primaryForm.direction === 'bearish' ? currentPrice <= primaryForm.target : false);
    const executionText = !shapeConfirmed
      ? confirmationPrice === null
        ? `${primary.label}${primaryForm.name}目前没有明确确认价，暂不操作。`
        : `${primary.label}${primaryForm.name}还没确认。现价 ${formatPrice(currentPrice)}，还要${movementWord}约 ${formatPrice(confirmationDistance!)} 点（${formatPercent(confirmationDistancePercent!)}）到 ${formatPrice(confirmationPrice)}；目前 ${primary.indicatorConfirmation.count}/4 项指标支持，${missingIndicators.join('、') || '其余指标'}仍未转强。`
      : targetReached
        ? `${primary.label}${primaryForm.name}的一倍量度目标 ${formatPrice(primaryForm.target!)} 已经到达，原形态已兑现，不能再把它当成追价开仓信号。已有仓位优先看保护利润；新方向要等新的整理、回测或二波段结构。`
      : !indicatorsConfirmed
        ? `${primary.label}${primaryForm.name}虽已破线，但只有 ${primary.indicatorConfirmation.count}/4 项指标同向；${missingIndicators.join('、')}仍偏弱，这次破线还不能算有效。`
        : farFromTrigger
          ? `${primary.label}${primaryForm.name}已有 ${primary.indicatorConfirmation.count}/4 项指标确认，但现价 ${formatPrice(currentPrice)} 已离确认价 ${formatPrice(confirmationPrice!)} 约 ${formatPrice(confirmationDistance!)} 点（${formatPercent(confirmationDistancePercent!)}），现在不追；等回到 ${retestZone ? `${formatPrice(retestZone.low)}–${formatPrice(retestZone.high)}` : '确认线附近'}，守住后再看。`
          : `${primary.label}${primaryForm.name}已有 ${primary.indicatorConfirmation.count}/4 项指标确认；现价 ${formatPrice(currentPrice)} 距确认价 ${formatPrice(confirmationPrice!)} 约 ${formatPrice(confirmationDistance!)} 点，仍在确认价附近，接下来观察回测能否守住。`;
    const riskDistance = confirmationPrice !== null && primaryForm.invalidation !== null
      ? Math.abs(primaryForm.invalidation / confirmationPrice - 1) : null;
    const hardStop = confirmationPrice === null || primaryForm.direction === 'neutral'
      ? null
      : confirmationPrice * (primaryForm.direction === 'bullish' ? 1 - hardStopRate : 1 + hardStopRate);
    const effectiveStop = primaryForm.invalidation === null
      ? hardStop
      : hardStop === null
        ? primaryForm.invalidation
        : primaryForm.direction === 'bullish'
          ? Math.max(primaryForm.invalidation, hardStop)
          : primaryForm.direction === 'bearish'
            ? Math.min(primaryForm.invalidation, hardStop)
            : null;
    const effectiveRiskDistance = confirmationPrice !== null && effectiveStop !== null
      ? Math.abs(effectiveStop / confirmationPrice - 1) : null;
    const validLevels = (values: Array<number | null | undefined>) => values.filter((value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0);
    const roadmapStatus = (low: number, high: number, direction: 'up' | 'down') => direction === 'up'
      ? currentPrice > high * 1.001
        ? 'passed' as const
        : currentPrice >= low * 0.997
          ? 'testing' as const
          : 'waiting' as const
      : currentPrice < low * 0.999
        ? 'passed' as const
        : currentPrice <= high * 1.003
          ? 'testing' as const
          : 'waiting' as const;
    const contextResistanceLevels = validLevels([
      analyses['1h'].contextPattern?.includes('M头') ? analyses['1h'].contextLevel : null,
      analyses['4h'].contextPattern?.includes('M头') ? analyses['4h'].contextLevel : null,
    ]).sort((left, right) => left - right);
    const fallbackBarrier = resistances.slice(0, 2);
    const barrierLevels = contextResistanceLevels.length ? contextResistanceLevels : fallbackBarrier;
    const makeRoadmapStep = (label: string, values: Array<number | null | undefined>, condition: string, direction: 'up' | 'down' = 'up') => {
      const levels = validLevels(values).sort((left, right) => left - right);
      if (!levels.length) return null;
      const low = levels[0];
      const high = levels.at(-1)!;
      return { label, low, high, status: roadmapStatus(low, high, direction), condition };
    };
    const rawUpsideRoadmap = [
      makeRoadmapStep('短线第一目标', [analyses['15m'].technicalForm.target], '先看15分钟形态能否兑现；接近后观察是否放量，而不是只看瞬间刺破。'),
      makeRoadmapStep(contextResistanceLevels.length ? '真正压力区' : '高周期关键压力', barrierLevels, contextResistanceLevels.length
        ? '1小时或4小时实体站上并回踩守住，才算解除更大M头压力。'
        : '实体站上并回踩守住，才进入下一目标。'),
      makeRoadmapStep('突破后的下一目标', [analyses['1h'].technicalForm.target], '必须先站稳前一压力区；若冲高后立即跌回，仍按反弹失败处理。'),
      makeRoadmapStep('4小时波段目标 T1', [analyses['4h'].technicalForm.target, analyses['1h'].technicalForm.target2], '前方压力全部转为支撑后，才看这一波段满足区。'),
      makeRoadmapStep('日线反转门槛', [analyses['1d'].technicalForm.trigger], `日线实体突破且成交量达到${bullishVolumeThreshold.toFixed(2)}倍均量，反弹才升级为日线反转。`),
      makeRoadmapStep('4小时延伸目标 T2', [analyses['4h'].technicalForm.target2], '只有日线反转门槛确认后，才把这里列为延伸目标。'),
      makeRoadmapStep(
        analyses['1d'].technicalForm.direction === 'bullish'
          && analyses['1d'].technicalForm.target !== null
          && currentPrice >= analyses['1d'].technicalForm.target
          ? '日线第二阶段满足位 T2' : '日线第一阶段满足位 T1',
        [analyses['1d'].technicalForm.direction === 'bullish'
          && analyses['1d'].technicalForm.target !== null
          && currentPrice >= analyses['1d'].technicalForm.target
          ? analyses['1d'].technicalForm.target2 : analyses['1d'].technicalForm.target],
        analyses['1d'].technicalForm.direction === 'bullish'
          && analyses['1d'].technicalForm.target !== null
          && currentPrice >= analyses['1d'].technicalForm.target
          ? `第一阶段 ${formatPrice(analyses['1d'].technicalForm.target)} 已兑现；这里是按同一形态高度再投射一次的第二阶段，不代表必然到达。`
          : '属于日线形态第一阶段满足位，尚未到达前不越级预期。',
      ),
    ];
    const upsideRoadmap = rawUpsideRoadmap.filter((step): step is NonNullable<typeof step> => step !== null)
      .filter((step, index, items) => index === 0 || step.high > items[index - 1].high * 1.001)
      .filter((step) => step.high >= currentPrice * 0.99);
    const rawDownsideRoadmap = [
      makeRoadmapStep('1小时M头满足位', [analyses['1h'].contextPattern?.includes('M头') ? analyses['1h'].contextTarget : null], '该目标若已跌破，说明1小时M头跌幅已经兑现；重新站回其上才算修复。', 'down'),
      makeRoadmapStep('短线防守线', [analyses['15m'].technicalForm.invalidation], `15分钟实体收在该线下方后，当前${analyses['15m'].technicalForm.name}才算失效；盘中触及不直接判弱。`, 'down'),
      makeRoadmapStep('最近支撑', [supports[0]], '实体跌破且反抽站不回，才打开下一段下行空间；盘中插针不算有效跌破。', 'down'),
      makeRoadmapStep('日线低点支撑', [supports[1]], '跌破后日线支撑结构明显转弱，再看下方高周期量度满足位。', 'down'),
      makeRoadmapStep('4小时M头满足位', [analyses['4h'].contextPattern?.includes('M头') ? analyses['4h'].contextTarget : null], '这是4小时已确认M头的量度跌幅目标，接近后观察是否出现放量止跌。', 'down'),
      makeRoadmapStep(`${primary.label}${primaryForm.name}彻底失效`, [effectiveStop], `跌到这里说明${primary.label}${primaryForm.name}判断失效，不能继续按原形态处理。`, 'down'),
      makeRoadmapStep('空头形态延伸目标', intervals.flatMap((interval) => {
        const form = analyses[interval].technicalForm;
        return form.direction === 'bearish' ? [form.target, form.target2] : [];
      }), '只有前方支撑依次跌破，才参考这里；没有连续破位时不越级看空。', 'down'),
    ];
    const downsideRoadmap = rawDownsideRoadmap.filter((step): step is NonNullable<typeof step> => step !== null)
      .filter((step) => step.low <= currentPrice * 1.01)
      .sort((left, right) => right.high - left.high)
      .filter((step, index, items) => index === 0 || Math.abs(step.high / items[index - 1].high - 1) > 0.0015);
    const firstRoadmapTarget = upsideRoadmap.find((step) => step.status !== 'passed') ?? upsideRoadmap.at(-1) ?? null;
    const firstDownsideTarget = downsideRoadmap.find((step) => step.status !== 'passed') ?? downsideRoadmap.at(-1) ?? null;
    const keyBarrier = upsideRoadmap.find((step) => step.label.includes('压力')) ?? null;
    const roadmapConclusion = overallBias === 'bearish' || analyses['4h'].indicatorConfirmation.count < 3
      ? `当前上涨先按反弹看：4小时${analyses['4h'].technicalForm.name}虽出现，但只有 ${analyses['4h'].indicatorConfirmation.count}/4 项指标支持。${keyBarrier ? `在 ${formatPrice(keyBarrier.low)}${keyBarrier.high !== keyBarrier.low ? `–${formatPrice(keyBarrier.high)}` : ''} 没有被实体站稳前，不把行情定义为反转。` : ''}`
      : `当前上涨获得4小时至少3项指标支持，按上升路径逐级观察，但每一层都要通过实体收盘和回测确认。`;
    const downsideConclusion = firstDownsideTarget
      ? `下方先看 ${formatPrice(firstDownsideTarget.low)}${firstDownsideTarget.high !== firstDownsideTarget.low ? `–${formatPrice(firstDownsideTarget.high)}` : ''}。${firstDownsideTarget.condition}`
      : '下方暂时没有可计算的有效结构位，不能据此预设下跌目标。';
    const summary = overallBias === 'bearish'
      ? '现在下跌一方更强。短暂上涨先当成普通反弹，不能直接理解为行情已经反转。'
      : overallBias === 'bullish'
        ? '现在上涨一方更强。短暂下跌先看作回落，只要没有跌破下方关键位置，整体方向仍然较强。'
        : '现在多空双方都没有明显优势，价格容易上下反复，最好等待方向真正走出来。';
    return NextResponse.json({
      generatedAt: now,
      source: futures ? ('source' in futures ? futures.source : 'Binance USDⓈ-M Futures WebSocket') : marketSource,
      historySource, indicatorDataReliable,
      market: futures ? 'futures' : 'spot_fallback',
      contract: futures ? {
        connected: true, lastPrice: futures.lastPrice, lastTradeTime: futures.lastTradeTime,
        markPrice: futures.markPrice, indexPrice: futures.indexPrice,
        fundingRate: futures.fundingRate, nextFundingTime: futures.nextFundingTime,
        bid: futures.bid, ask: futures.ask, connectedAt: futures.connectedAt,
      } : { connected: false },
      symbol: 'BTCUSDT', currentPrice,
      overallBias, overallLabel, weightedScore, summary, analyses, supports, resistances,
      marketRoadmap: {
        headline: firstRoadmapTarget
          ? `眼前先看 ${formatPrice(firstRoadmapTarget.low)}${firstRoadmapTarget.high !== firstRoadmapTarget.low ? `–${formatPrice(firstRoadmapTarget.high)}` : ''}`
          : '当前上方没有可计算的有效目标',
        downsideHeadline: firstDownsideTarget
          ? `下方先防 ${formatPrice(firstDownsideTarget.low)}${firstDownsideTarget.high !== firstDownsideTarget.low ? `–${formatPrice(firstDownsideTarget.high)}` : ''}`
          : '当前下方没有可计算的有效目标',
        conclusion: roadmapConclusion,
        downsideConclusion,
        upside: upsideRoadmap,
        downside: downsideRoadmap,
      },
      confirmedBreakdowns, confirmedBreakouts, measuredTarget, measuredSource: measuredSource ?? null,
      tradePlan: {
        interval: primaryInterval, pattern: primaryForm.name, direction: primaryForm.direction,
        stage: primaryForm.stage, indicatorConfirmation: primary.indicatorConfirmation,
        shapeConfirmed, indicatorsConfirmed, qualified: shapeConfirmed && indicatorsConfirmed,
        confirmationPrice, retestZone, invalidation: primaryForm.invalidation,
        hardStop, effectiveStop, measuredTarget: primaryForm.target, measuredTarget2: primaryForm.target2,
        currentPrice, farFromTrigger, targetReached, executionText,
        riskDistance: effectiveRiskDistance, structureRiskDistance: riskDistance,
        riskWarning: effectiveRiskDistance !== null && effectiveRiskDistance > 0.03
          ? `执行止损距确认价 ${formatPercent(effectiveRiskDistance)}，对高杠杆仓位风险较大；实际保证金影响以上方“我的合约仓位”填写结果为准。`
          : effectiveRiskDistance !== null
            ? `执行止损距确认价 ${formatPercent(effectiveRiskDistance)}；应结合你的实际杠杆、数量和账户权益判断能否承受。`
            : '当前形态没有可计算的结构失效位，不能据此设置杠杆风险。',
        formula: '有效确认价 = 形态确认线 ± 0.10 ATR；T1 = 突破点 ± H；T2 = 突破点 ± 2H；执行止损取形态失效位与6%硬止损中更近者。',
      },
      bullCondition: resistances.length
        ? `先收复 ${resistances[0].toLocaleString('en-US', { maximumFractionDigits: 0 })}，再观察1小时或4小时回测不破。`
        : '等待放量突破最近20根K线高点。',
      bearCondition: supports.length
        ? `跌破 ${supports[0].toLocaleString('en-US', { maximumFractionDigits: 0 })} 后，下一支撑依次观察下方关键位。`
        : '等待放量跌破最近20根K线低点。',
      riskNote: '杠杆、数量和账户权益以上方“我的合约仓位”为准；系统不会用固定仓位替代你的真实数据。',
      ruleSet: '蔡森12形态量价规则 v1',
      modelStatus: 'research_only',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '实时行情分析失败' }, { status: 502 });
  }
}
