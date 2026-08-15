# 机器学习流水线

该流水线使用Binance Spot BTCUSDT历史K线，构建四个独立周期模型：15m、1h、4h、1d。

特征包括：价格动量、ATR、K线实体与影线、EMA结构、MACD水上/水下金叉死叉、MACD/RSI顶底背离、成交量Z分数、相对成交量、OBV、CMF、主动买入比例、量价相关、突破/假突破/破低翻、头肩结构、双顶底相似度、三角收敛与旗杆比例。

标签：当前K线收盘生成信号，下一根K线开盘入场。未来24根K线内先触及 `+1.5 ATR` 为上涨，先触及 `-1.5 ATR` 为下跌，其余按期末移动判断或记为中性。

训练：前64%训练，随后16%验证调参，最后20%作为一次性样本外测试。测试集不会参与模型或阈值选择。

运行：

```powershell
& 'C:\Users\34796\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' .\ml\pipeline.py all --start 2021-01-01
```

## 新增原则研究分支

先审计单规则，再运行与冻结基线同口径的因果模型池：

```powershell
& .\.venv\Scripts\python.exe .\ml\evaluate_principle_rules.py
& .\.venv\Scripts\python.exe .\ml\walk_forward_principles.py
```

输出分别为 `reports/principle-rule-audit.json` 和 `reports/walk-forward-principles.json`。增强方案只有在 AUC、成本后单笔均值、盈亏因子均不低于冻结基线，并通过原上线门槛及跨年份/多空稳定性检查时才可采纳。
