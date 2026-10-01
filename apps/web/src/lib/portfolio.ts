// apps/web/src/lib/portfolio.ts
//
// Server-side portfolio building blocks.
//
// WHAT IS AND ISN'T REAL HERE:
//   - Balances are read live from chain over RPC. They are the wallet's actual
//     balances, not a number derived from our own swap records.
//   - Prices come from getServerTokenPrice (DexScreener -> DefiLlama). A token
//     we cannot price is reported with a null price and excluded from the
//     total, rather than being valued at zero.
//   - Cost basis and unrealised PnL are NOT derivable from what we store: the
//     Swap row records input/output amounts but not the USD value at the time
//     of execution, and we have no historical price source. Callers get
//     costBasisAvailable: false and zeroed cost fields rather than a number
//     reverse-engineered from today's price, which would be fiction.
//
// WHICH TOKENS GET LISTED: the set a user has traded through OmniSwap (from
// their Swap rows), plus the native coin of each chain they have traded on.
// Enumerating every token an arbitrary address has ever touched needs an
// indexer (Alchemy/Covalent/Moralis); none is configured, and guessing is
// worse than a well-defined subset.

import { createPublicClient, http, formatUnits, getAddress, type Address } from 'viem';
import { getChainRpc, getChainById } from '@/lib/chain-config';
import { getServerTokenPrice } from '@/lib/serverPrice';

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

/** EVM native coin, as the swap routes and 1inch represent it. */
export const NATIVE_SENTINELS = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

export function isNativeAddress(address: string): boolean {
  return NATIVE_SENTINELS.has(address.toLowerCase());
}

export interface TokenRef {
  chainId: string;
  address: string;
  symbol: string;
}

export interface RawBalance {
  chainId: string;
  address: string;
  symbol: string;
  balance: string; // human-readable, already divided by decimals
  decimals: number;
}

function publicClientFor(chainId: string) {
  const rpc = getChainRpc(chainId);
  if (!rpc) return null;
  return createPublicClient({ transport: http(rpc) });
}

/**
 * Live balances for one EVM chain. Tokens that revert (not an ERC-20, wrong
 * chain, dead RPC) are dropped rather than reported as a zero balance, so a
 * broken lookup never masquerades as "you hold none of this".
 */
export async function readEvmBalances(
  chainId: string,
  owner: string,
  tokens: TokenRef[]
): Promise<RawBalance[]> {
  const client = publicClientFor(chainId);
  if (!client) return [];

  let ownerAddress: Address;
  try {
    ownerAddress = getAddress(owner);
  } catch {
    return []; // not an EVM address - a Solana/Sui session, nothing to read here
  }

  const out: RawBalance[] = [];

  const native = tokens.find((t) => isNativeAddress(t.address));
  if (native) {
    try {
      const chain = getChainById(chainId);
      const balance = await client.getBalance({ address: ownerAddress });
      out.push({
        chainId,
        address: native.address,
        symbol: chain?.symbol || native.symbol,
        balance: formatUnits(balance, 18),
        decimals: 18,
      });
    } catch {
      // RPC unreachable for this chain; skip rather than report a false zero
    }
  }

  const erc20s = tokens.filter((t) => !isNativeAddress(t.address));

  const results = await Promise.allSettled(
    erc20s.map(async (token): Promise<RawBalance> => {
      const address = getAddress(token.address);
      const [balance, decimals] = await Promise.all([
        client.readContract({
          address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [ownerAddress],
        }),
        client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
      ]);
      return {
        chainId,
        address: token.address,
        symbol: token.symbol,
        balance: formatUnits(balance as bigint, Number(decimals)),
        decimals: Number(decimals),
      };
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled') out.push(r.value);
  }

  return out;
}

/**
 * Price a set of balances. Returns one holding per token, with a null price
 * where no source could price it. `totalValueUsd` only counts priced tokens.
 */
export async function priceBalances(balances: RawBalance[]) {
  const priced = await Promise.all(
    balances.map(async (b) => {
      const price = await getServerTokenPrice(b.chainId, b.address);
      const amount = Number(b.balance);
      const priceUsd = price?.priceUsd ?? null;
      const valueUsd = priceUsd !== null && Number.isFinite(amount) ? amount * priceUsd : null;
      return { ...b, priceUsd, valueUsd, change24h: price?.change24h ?? 0 };
    })
  );

  const totalValueUsd = priced.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  return { priced, totalValueUsd };
}

/**
 * The token set to show for a user: everything they have swapped into or out
 * of, plus the native coin of each chain involved. Deduplicated per chain.
 */
export function tokensFromSwaps(
  swaps: Array<{
    inputChainId: string;
    inputToken: string;
    outputChainId: string;
    outputToken: string;
  }>
): Map<string, TokenRef[]> {
  const byChain = new Map<string, Map<string, TokenRef>>();

  const add = (chainId: string, address: string) => {
    if (!chainId || !address) return;
    const chain = getChainById(chainId);
    if (!chain || chain.type !== 'evm') return; // only EVM balances are readable here
    if (!byChain.has(chainId)) byChain.set(chainId, new Map());
    const key = address.toLowerCase();
    const bucket = byChain.get(chainId)!;
    if (!bucket.has(key)) bucket.set(key, { chainId, address, symbol: '' });
  };

  for (const s of swaps) {
    add(s.inputChainId, s.inputToken);
    add(s.outputChainId, s.outputToken);
  }

  // Always include the chain's native coin - it pays the gas, so a user
  // trading on a chain almost certainly holds some.
  for (const [chainId, bucket] of byChain) {
    const zero = '0x0000000000000000000000000000000000000000';
    if (![...bucket.keys()].some((a) => isNativeAddress(a))) {
      bucket.set(zero, {
        chainId,
        address: zero,
        symbol: getChainById(chainId)?.symbol || 'NATIVE',
      });
    }
  }

  return new Map([...byChain].map(([chainId, bucket]) => [chainId, [...bucket.values()]]));
}

/** Timeframe string from the UI -> cutoff Date, or null for "all". */
export function timeframeCutoff(timeframe: string): Date | null {
  const hours: Record<string, number> = {
    '24h': 24,
    '7d': 24 * 7,
    '30d': 24 * 30,
    '90d': 24 * 90,
    '1y': 24 * 365,
  };
  const h = hours[timeframe];
  return h ? new Date(Date.now() - h * 60 * 60 * 1000) : null;
}
