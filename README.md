# Binance BTC Monitor

一个面向 BTCUSDT 永续合约的实时技术形态分析页面，使用 Binance 公共行情接口获取 K 线、资金费率和合约指标，并按 15 分钟、1 小时、4 小时和日线周期整理为直观的交易观察结论。

## 功能

- 每 3 秒刷新当前 BTCUSDT 永续合约行情
- 多周期 K 线形态识别：突破、跌破、旗形、三角形、双底/双顶等
- MACD、成交量、均线和波动率对形态进行确认
- 输出关键压力/支撑、上涨路线、下跌路线和条件触发点
- 附带历史数据、形态规则、模型与回测报告，便于复核分析依据

## 本地运行

需要 Node.js 18 或更高版本。

```bash
npm install
npm run dev
```

打开 http://localhost:3000/analysis 。

页面只使用 Binance 公共市场数据，不需要填写 API Key；项目不包含下单功能。技术分析仅供研究参考，不构成投资建议。

## 机器学习资料

`ml/` 包含特征工程、训练和滚动验证脚本，`data/` 保存用于复核的历史样本，`models/` 和 `reports/` 保存当前生成的模型与评估结果。详细规则见 [`docs/pattern-rules.md`](docs/pattern-rules.md)。

