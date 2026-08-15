import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

type ForwardSignal = {
  side: 'long' | 'short';
  resolved: boolean;
  success: boolean;
  return_after_cost: number;
};

function summarizeSide(signals: ForwardSignal[], side: ForwardSignal['side']) {
  const sideSignals = signals.filter((signal) => signal.side === side);
  const resolved = sideSignals.filter((signal) => signal.resolved);
  const wins = resolved.filter((signal) => signal.success).length;
  const returns = resolved.map((signal) => signal.return_after_cost);
  const gains = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));

  return {
    candidates: sideSignals.length,
    resolved: resolved.length,
    hitRate: resolved.length ? wins / resolved.length : null,
    meanReturn: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? null : resolved.length ? 0 : null,
    usable: false,
    verdict: resolved.length
      ? `${side === 'long' ? '多单' : '空单'}仅有 ${resolved.length} 笔前向样本，不能用于下单。`
      : `${side === 'long' ? '多单' : '空单'}尚无前向样本，不能评估。`,
  };
}

function dataTimestamp(csv: string) {
  const lastRow = csv.trim().split(/\r?\n/).at(-1);
  if (!lastRow) return null;
  const columns = lastRow.split(',');
  const timestamp = Number(columns[6] ?? columns[0]);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export async function GET() {
  try {
    const reportPath = path.join(process.cwd(), 'reports', 'walk-forward-model-pool.json');
    const forwardPath = path.join(process.cwd(), 'reports', 'forward-validation.json');
    const principlesPath = path.join(process.cwd(), 'reports', 'walk-forward-principles.json');
    const ruleAuditPath = path.join(process.cwd(), 'reports', 'principle-rule-audit.json');
    const futures4hPath = path.join(process.cwd(), 'data', 'futures', 'BTCUSDT_4h.csv');
    const [report, forward, principles, ruleAudit, futures4h] = await Promise.all([
      readFile(reportPath, 'utf8').then(JSON.parse),
      readFile(forwardPath, 'utf8').then(JSON.parse),
      readFile(principlesPath, 'utf8').then(JSON.parse),
      readFile(ruleAuditPath, 'utf8').then(JSON.parse),
      readFile(futures4hPath, 'utf8'),
    ]);
    const forwardSignals = forward.signals as ForwardSignal[];
    const requirements = forward.requirements;
    const dataAsOf = dataTimestamp(futures4h);
    const dataAgeHours = dataAsOf ? Math.max(0, (Date.now() - new Date(dataAsOf).getTime()) / 3_600_000) : null;
    const dataFreshness = dataAgeHours === null ? 'unknown' : dataAgeHours <= 8 ? 'current' : dataAgeHours <= 72 ? 'aging' : 'stale';
    const modelChecks = [
      { key: 'auc', label: '区分方向', passed: report.auc > 0.52, actual: report.auc, target: '> 0.52', format: 'decimal' },
      { key: 'meanReturn', label: '扣成本收益', passed: report.mean_return > 0, actual: report.mean_return, target: '> 0', format: 'percent' },
      { key: 'profitFactor', label: '赚亏效率', passed: report.profit_factor >= requirements.minimum_profit_factor, actual: report.profit_factor, target: `≥ ${requirements.minimum_profit_factor}`, format: 'decimal' },
      { key: 'forwardSignals', label: '前向样本', passed: forward.summary.resolved_signals >= requirements.minimum_resolved_signals, actual: forward.summary.resolved_signals, target: `≥ ${requirements.minimum_resolved_signals} 笔`, format: 'integer' },
      { key: 'calendarDays', label: '观察时间', passed: forward.summary.calendar_days >= requirements.minimum_calendar_days, actual: forward.summary.calendar_days, target: `≥ ${requirements.minimum_calendar_days} 天`, format: 'integer' },
    ];
    const failedChecks = modelChecks.filter((check) => !check.passed);
    const principleChecks = [
      { key: 'auc', label: '方向识别', passed: principles.comparison.auc_delta >= 0, delta: principles.comparison.auc_delta, format: 'decimal' },
      { key: 'meanReturn', label: '扣成本收益', passed: principles.comparison.mean_return_delta >= 0, delta: principles.comparison.mean_return_delta, format: 'percent' },
      { key: 'profitFactor', label: '赚亏效率', passed: principles.comparison.profit_factor_delta >= 0, delta: principles.comparison.profit_factor_delta, format: 'decimal' },
    ];
    return NextResponse.json({
      status: report.approved ? 'approved' : 'research_only', interval: '4h', model: 'causal model pool',
      predictedRows: report.predicted_rows, signals: report.signals, auc: report.auc, hitRate: report.hit_rate,
      meanReturn: report.mean_return, profitFactor: report.profit_factor,
      baselineMeanReturn: report.raw_rule_baseline?.mean_return ?? null,
      baselineProfitFactor: report.raw_rule_baseline?.profit_factor ?? null,
      forward: forward.summary,
      decision: {
        state: report.approved && forward.summary.eligible_for_review ? 'reviewable' : 'blocked',
        label: report.approved && forward.summary.eligible_for_review ? '可进入人工复核' : '禁止参与交易',
        action: '不用于开仓、加仓、减仓或止损；当前多空判断只看已确认的价格结构。',
        reason: `共 ${failedChecks.length} 项硬门槛未通过；历史样本扣成本后为负，前向验证仅 ${forward.summary.resolved_signals}/${requirements.minimum_resolved_signals} 笔。`,
        checks: modelChecks,
        sides: {
          long: summarizeSide(forwardSignals, 'long'),
          short: summarizeSide(forwardSignals, 'short'),
        },
      },
      freshness: {
        reportUpdatedAt: forward.updated_at,
        modelCutoff: new Date(forward.model_cutoff).toISOString(),
        dataAsOf,
        dataAgeHours,
        state: dataFreshness,
        isStaticReport: true,
        message: dataFreshness === 'current'
          ? '历史验证数据已更新。'
          : '这是静态历史报告，不会随页面每3秒刷新重新训练。',
      },
      principleUpgrade: {
        adopted: principles.approved && principles.no_quality_regression,
        selectedRules: principles.selected_rules,
        testedRules: ruleAudit.rules.length,
        auc: principles.auc,
        signals: principles.signals,
        hitRate: principles.hit_rate,
        meanReturn: principles.mean_return,
        profitFactor: principles.profit_factor,
        comparison: principles.comparison,
        baseline: principles.frozen_baseline,
        decision: {
          state: principles.approved && principles.no_quality_regression ? 'adopted' : 'rejected',
          label: principles.approved && principles.no_quality_regression ? '允许替换旧规则' : '拒绝加入当前规则库',
          action: principles.approved && principles.no_quality_regression
            ? '进入前向观察，不直接产生买卖点。'
            : '维持原规则；本轮新增原则不会改变当前多空结论或关键点位。',
          summary: `${ruleAudit.rules.length} 条规则中仅 ${principles.selected_rules.length} 条通过预筛选，但组合后有 ${principleChecks.filter((check) => !check.passed).length} 项核心质量下降。`,
          checks: principleChecks,
        },
        reason: principles.no_quality_regression
          ? '候选方案未达到上线硬门槛，继续研究。'
          : '候选方案的成本后收益或盈亏因子低于冻结基线，已自动拒绝，当前模型保持不变。',
      },
      message: report.approved ? '模型已通过开发期门槛，仍需前向纸面验证。' : '模型未通过上线门槛，页面不生成机器学习买卖信号。',
    });
  } catch {
    return NextResponse.json({ status: 'unavailable', message: '模型报告尚不可用。' }, { status: 503 });
  }
}
