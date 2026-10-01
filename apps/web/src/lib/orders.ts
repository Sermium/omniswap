// apps/web/src/lib/orders.ts
//
// Mapping between the Prisma enums and the lowercase strings the
// limit-orders / DCA pages already expect, plus the shared "is this order
// ready?" rule used by both the API and the price-watch cron.
//
// IMPORTANT: nothing in this module (or the cron that uses it) signs or sends
// a transaction. Reaching the target price only marks an order ready; the
// actual swap still requires the user's connected wallet. Unattended execution
// needs the smart-contract allowance + keeper design, which is a separate,
// security-reviewed piece of work.

import type { OrderStatus, OrderType, DCAStatus, DCAFrequency } from '@prisma/client';

export const DB_TO_UI_ORDER_STATUS: Record<OrderStatus, string> = {
  PENDING: 'active',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  FAILED: 'cancelled',
};

export function toUiOrder(row: any) {
  const num = (v: any) => (v == null ? 0 : Number(v));
  const inputAmount = num(row.inputAmount);
  const filled = num(row.outputAmount);

  return {
    id: row.id,
    type: (row.type as OrderType) === 'BUY' ? 'buy' : 'sell',
    status: DB_TO_UI_ORDER_STATUS[row.status as OrderStatus] ?? 'active',
    fromChainId: row.fromChainId,
    toChainId: row.toChainId,
    fromToken: {
      address: row.fromTokenAddress,
      symbol: row.fromTokenSymbol,
      name: row.fromTokenSymbol,
      decimals: 18,
      chainId: row.fromChainId,
    },
    toToken: {
      address: row.toTokenAddress,
      symbol: row.toTokenSymbol,
      name: row.toTokenSymbol,
      decimals: 18,
      chainId: row.toChainId,
    },
    inputAmount: row.inputAmount,
    targetPrice: num(row.targetPrice),
    // Last price the watcher actually observed; 0 when it hasn't run yet
    // rather than a made-up number.
    currentPrice: num(row.readyPrice),
    minOutputAmount: row.minOutputAmount,
    filledAmount: row.outputAmount ?? '0',
    filledPercent: inputAmount > 0 && filled > 0 ? Math.min(100, (filled / inputAmount) * 100) : 0,
    slippage: row.slippage,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : undefined,
    createdAt: new Date(row.createdAt).toISOString(),
    executedAt: row.executedAt ? new Date(row.executedAt).toISOString() : undefined,
    executedTxHash: row.executedTxHash ?? undefined,
    outputAmount: row.outputAmount ?? undefined,
    // Extra fields the current UI ignores but that make the manual-execution
    // flow possible without another round trip.
    readyAt: row.readyAt ? new Date(row.readyAt).toISOString() : undefined,
    readyPrice: row.readyPrice ? num(row.readyPrice) : undefined,
  };
}

/**
 * A BUY fills when the price drops to/below target; a SELL when it rises
 * to/above. Returns false on a missing or nonsensical price rather than
 * guessing.
 */
export function isOrderReady(
  type: OrderType,
  targetPrice: number,
  currentPrice: number
): boolean {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) return false;
  return type === 'BUY' ? currentPrice <= targetPrice : currentPrice >= targetPrice;
}

export const UI_TO_DB_FREQUENCY: Record<string, DCAFrequency> = {
  hourly: 'HOURLY',
  daily: 'DAILY',
  weekly: 'WEEKLY',
  biweekly: 'BIWEEKLY',
  monthly: 'MONTHLY',
  custom: 'CUSTOM',
};

const FREQUENCY_MS: Record<DCAFrequency, number> = {
  HOURLY: 60 * 60 * 1000,
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
  BIWEEKLY: 14 * 24 * 60 * 60 * 1000,
  MONTHLY: 30 * 24 * 60 * 60 * 1000,
  CUSTOM: 24 * 60 * 60 * 1000,
};

export function nextExecutionAfter(
  frequency: DCAFrequency,
  from: Date,
  customIntervalHours?: number | null
): Date {
  const step =
    frequency === 'CUSTOM' && customIntervalHours
      ? customIntervalHours * 60 * 60 * 1000
      : FREQUENCY_MS[frequency];
  return new Date(from.getTime() + step);
}

export function toUiStrategy(row: any) {
  return {
    id: row.id,
    name: row.name ?? `${row.fromTokenSymbol} → ${row.toTokenSymbol}`,
    status: row.status as DCAStatus,
    amountPerExecution: row.amountPerExecution,
    fromTokenSymbol: row.fromTokenSymbol,
    toTokenSymbol: row.toTokenSymbol,
    fromChainId: row.fromChainId,
    toChainId: row.toChainId,
    frequency: row.frequency,
    nextExecutionAt: row.nextExecutionAt ? new Date(row.nextExecutionAt).toISOString() : null,
    totalExecutions: row.totalExecutions ?? null,
    executedCount: row.executedCount,
    totalInputAmount: row.totalInputAmount,
    totalOutputAmount: row.totalOutputAmount,
    readyAt: row.readyAt ? new Date(row.readyAt).toISOString() : undefined,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
