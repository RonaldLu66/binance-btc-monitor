export type PositionDraft = {
  side: 'long' | 'short';
  entryPrice: string;
  quantityBtc: string;
  leverage: string;
  marginMode: 'isolated' | 'cross';
  stopLoss: string;
  liquidationPrice: string;
  accountEquity: string;
};

export const emptyPosition: PositionDraft = {
  side: 'long',
  entryPrice: '',
  quantityBtc: '',
  leverage: '30',
  marginMode: 'isolated',
  stopLoss: '',
  liquidationPrice: '',
  accountEquity: '',
};

export function numericPosition(position: PositionDraft) {
  const parse = (value: string) => {
    const result = Number(value);
    return Number.isFinite(result) && result > 0 ? result : null;
  };
  return {
    entryPrice: parse(position.entryPrice),
    quantityBtc: parse(position.quantityBtc),
    leverage: parse(position.leverage),
    stopLoss: parse(position.stopLoss),
    liquidationPrice: parse(position.liquidationPrice),
    accountEquity: parse(position.accountEquity),
  };
}
