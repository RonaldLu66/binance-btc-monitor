export type PatternSignal = {
  name: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  status: '形成中' | '已触发' | '待确认';
  triggerPrice: number;
  target: number | null;
  targetPercent: number | null;
  invalidation: number | null;
  note: string;
};

export type PatternStat = { name: string; samples: number; wins: number; losses: number; unresolved: number; hitRate: number | null };

type Point = { high: number; low: number; close: number };
type Pivot = { index: number; price: number; kind: 'high' | 'low' };

function pivots(points: Point[], span = 2) {
  const output: Pivot[] = [];
  for (let index = span; index < points.length - span; index += 1) {
    const window = points.slice(index - span, index + span + 1);
    if (points[index].high === Math.max(...window.map((point) => point.high))) output.push({ index, price: points[index].high, kind: 'high' });
    if (points[index].low === Math.min(...window.map((point) => point.low))) output.push({ index, price: points[index].low, kind: 'low' });
  }
  return output.filter((pivot, index, items) => index === 0 || pivot.kind !== items[index - 1].kind || Math.abs(pivot.price - items[index - 1].price) / pivot.price > 0.002);
}

function buildSignal(name: string, direction: 'bullish' | 'bearish' | 'neutral', status: PatternSignal['status'], triggerPrice: number, target: number | null, invalidation: number | null, current: number, note: string): PatternSignal {
  return { name, direction, status, triggerPrice, target, targetPercent: target === null ? null : (target / current - 1) * 100, invalidation, note };
}

export function detectPatterns(points: Point[]): PatternSignal[] {
  if (points.length < 35) return [];
  const recent = points.slice(-100);
  const setup = recent.slice(0, -1);
  const currentBar = recent.at(-1)!;
  const current = currentBar.close;
  const previous = setup.at(-1)!.close;
  const swingPoints = pivots(recent).slice(-12);
  const highs = swingPoints.filter((pivot) => pivot.kind === 'high');
  const lows = swingPoints.filter((pivot) => pivot.kind === 'low');
  const signals: PatternSignal[] = [];
  const tolerance = 0.012;

  const lastTwoLows = lows.slice(-2);
  if (lastTwoLows.length === 2) {
    const [left, right] = lastTwoLows;
    const necklineCandidates = highs.filter((pivot) => pivot.index > left.index && pivot.index < right.index);
    const neckline = necklineCandidates.length ? Math.max(...necklineCandidates.map((pivot) => pivot.price)) : 0;
    const similar = Math.abs(left.price - right.price) / Math.min(left.price, right.price) <= tolerance;
    if (similar && neckline > 0 && right.index > left.index + 2) {
      const target = neckline + (neckline - Math.min(left.price, right.price));
      const status = current > neckline ? '已触发' : '形成中';
      signals.push(buildSignal('W底', 'bullish', status, neckline, target, Math.min(left.price, right.price), current, '双底至颈线的垂直距离，从突破点向上等幅投射。'));
    }
  }

  const lastTwoHighs = highs.slice(-2);
  if (lastTwoHighs.length === 2) {
    const [left, right] = lastTwoHighs;
    const necklineCandidates = lows.filter((pivot) => pivot.index > left.index && pivot.index < right.index);
    const neckline = necklineCandidates.length ? Math.min(...necklineCandidates.map((pivot) => pivot.price)) : 0;
    const similar = Math.abs(left.price - right.price) / Math.min(left.price, right.price) <= tolerance;
    if (similar && neckline > 0 && right.index > left.index + 2) {
      const target = neckline - (Math.max(left.price, right.price) - neckline);
      const status = current < neckline ? '已触发' : '形成中';
      signals.push(buildSignal('M头', 'bearish', status, neckline, target, Math.max(left.price, right.price), current, '双顶至颈线的垂直距离，从破位点向下等幅投射。'));
    }
  }

  const alternating = swingPoints.slice(-5);
  if (alternating.length === 5 && alternating.map((pivot) => pivot.kind).join() === 'high,low,high,low,high') {
    const [leftShoulder, leftNeck, head, rightNeck, rightShoulder] = alternating;
    const shouldersSimilar = Math.abs(leftShoulder.price - rightShoulder.price) / Math.min(leftShoulder.price, rightShoulder.price) <= 0.04;
    const neckline = (leftNeck.price + rightNeck.price) / 2;
    if (head.price > Math.max(leftShoulder.price, rightShoulder.price) && shouldersSimilar) {
      signals.push(buildSignal('头肩顶', 'bearish', current < neckline ? '已触发' : '形成中', neckline, neckline - (head.price - neckline), head.price, current, '头部至颈线的距离，从颈线破位处向下投射。'));
    }
  }
  if (alternating.length === 5 && alternating.map((pivot) => pivot.kind).join() === 'low,high,low,high,low') {
    const [leftShoulder, leftNeck, head, rightNeck, rightShoulder] = alternating;
    const shouldersSimilar = Math.abs(leftShoulder.price - rightShoulder.price) / Math.min(leftShoulder.price, rightShoulder.price) <= 0.04;
    const neckline = (leftNeck.price + rightNeck.price) / 2;
    if (head.price < Math.min(leftShoulder.price, rightShoulder.price) && shouldersSimilar) {
      signals.push(buildSignal('头肩底', 'bullish', current > neckline ? '已触发' : '形成中', neckline, neckline + (neckline - head.price), head.price, current, '头部至颈线的距离，从颈线突破处向上投射。'));
    }
  }

  if (highs.length >= 3 && lows.length >= 3) {
    const triangleHighs = highs.slice(-3);
    const triangleLows = lows.slice(-3);
    const fallingHighs = triangleHighs[0].price > triangleHighs[1].price && triangleHighs[1].price > triangleHighs[2].price;
    const risingLows = triangleLows[0].price < triangleLows[1].price && triangleLows[1].price < triangleLows[2].price;
    if (fallingHighs && risingLows) {
      const upper = triangleHighs.at(-1)!.price;
      const lower = triangleLows.at(-1)!.price;
      const height = triangleHighs[0].price - triangleLows[0].price;
      if (current > upper) signals.push(buildSignal('收敛三角形向上突破', 'bullish', '已触发', upper, upper + height, lower, current, '用三角形最宽处高度向上投射；2/3至3/4位置突破更理想。'));
      else if (current < lower) signals.push(buildSignal('收敛三角形向下破位', 'bearish', '已触发', lower, lower - height, upper, current, '用三角形最宽处高度向下投射；破位后反抽不过下沿更可靠。'));
      else signals.push(buildSignal('收敛三角形', 'neutral', '形成中', current, null, null, current, '等待有效突破，接近尖端后的突破可靠性下降。'));
    }
  }

  const resistance = Math.max(...setup.slice(-25).map((point) => point.high));
  const support = Math.min(...setup.slice(-25).map((point) => point.low));
  if (currentBar.high > resistance && current < resistance) signals.push(buildSignal('向上假突破', 'bearish', '待确认', resistance, null, currentBar.high, current, '刺破压力后收回其下；继续跌破近端支撑才确认卖出信号。'));
  if (currentBar.low < support && current > support) signals.push(buildSignal('破低翻', 'bullish', '待确认', support, null, currentBar.low, current, '跌破前低后重新收回；进一步突破上方颈线才构成加码确认。'));

  const prior = recent.slice(-35, -15);
  const consolidation = recent.slice(-15);
  const priorMove = prior.at(-1)!.close - prior[0].close;
  const consolidationHigh = Math.max(...consolidation.map((point) => point.high));
  const consolidationLow = Math.min(...consolidation.map((point) => point.low));
  if (priorMove > 0 && previous <= consolidationHigh && current > consolidationHigh) signals.push(buildSignal('波段上涨等幅 / 下降旗形突破', 'bullish', '已触发', consolidationHigh, consolidationHigh + Math.abs(priorMove), consolidationLow, current, '以前一段明确涨幅作为旗杆，从突破点向上等幅投射。'));
  if (priorMove < 0 && previous >= consolidationLow && current < consolidationLow) signals.push(buildSignal('波段下跌等幅 / 上升旗形破位', 'bearish', '已触发', consolidationLow, consolidationLow - Math.abs(priorMove), consolidationHigh, current, '以前一段明确跌幅作为旗杆，从破位点向下等幅投射。'));

  return signals.slice(0, 5);
}

export function evaluatePatterns(points: Point[], horizon = 24): PatternStat[] {
  if (points.length < 150) return [];
  const records = new Map<string, { wins: number; losses: number; unresolved: number }>();
  const lastAccepted = new Map<string, number>();
  for (let index = 100; index < points.length - horizon; index += 1) {
    const signals = detectPatterns(points.slice(0, index + 1)).filter((signal) => signal.status === '已触发' && signal.target !== null && signal.invalidation !== null);
    for (const signal of signals) {
      if (index - (lastAccepted.get(signal.name) ?? -100) < 8) continue;
      lastAccepted.set(signal.name, index);
      let result: 'wins' | 'losses' | 'unresolved' = 'unresolved';
      for (const bar of points.slice(index + 1, index + 1 + horizon)) {
        const targetHit = signal.direction === 'bullish' ? bar.high >= signal.target! : bar.low <= signal.target!;
        const invalidated = signal.direction === 'bullish' ? bar.low <= signal.invalidation! : bar.high >= signal.invalidation!;
        if (targetHit && invalidated) break;
        if (targetHit) { result = 'wins'; break; }
        if (invalidated) { result = 'losses'; break; }
      }
      const record = records.get(signal.name) ?? { wins: 0, losses: 0, unresolved: 0 };
      record[result] += 1;
      records.set(signal.name, record);
    }
  }
  return Array.from(records, ([name, result]) => {
    const resolved = result.wins + result.losses;
    return { name, ...result, samples: resolved + result.unresolved, hitRate: resolved ? result.wins / resolved * 100 : null };
  }).sort((left, right) => right.samples - left.samples);
}
