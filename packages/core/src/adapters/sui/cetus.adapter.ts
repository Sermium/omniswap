import axios, { AxiosInstance } from 'axios';
import { logger } from '../../utils/logger';
import { BaseAdapter, AdapterQuoteParams, AdapterQuoteResult, AdapterConfig } from '../base.adapter';

// Cetus needs nothing beyond the shared adapter config. Kept as a named alias
// rather than an empty interface so there is still one type to widen if it
// ever does need its own options.
export type CetusConfig = AdapterConfig;

const DEFAULT_CONFIG: CetusConfig = {
  baseUrl: 'https://api-sui.cetus.zone',
  timeout: 30000,
};

export class CetusAdapter extends BaseAdapter {
  readonly name = 'cetus';
  readonly type = 'DEX' as const;
  readonly supportedChains = ['sui', '784'];

  private client: AxiosInstance;
  private readonly SUI_COIN_TYPE = '0x2::sui::SUI';

  constructor(config: Partial<CetusConfig> = {}) {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    super(mergedConfig);

    this.client = axios.create({
      baseURL: mergedConfig.baseUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: mergedConfig.timeout || 30000,
    });
  }

  canHandle(params: AdapterQuoteParams): boolean {
    const fromChainId = params.fromChainId || params.inputToken.chainId;
    const toChainId = params.toChainId || params.outputToken.chainId;
    // Cetus only handles Sui same-chain swaps
    return fromChainId === toChainId && this.supportsChain(fromChainId);
  }

  private formatCoinType(coinType: string): string {
    if (coinType.toLowerCase() === 'sui' || coinType === '0x2::sui::SUI') {
      return this.SUI_COIN_TYPE;
    }
    return coinType.startsWith('0x') ? coinType : `0x${coinType}`;
  }

  async getQuote(params: AdapterQuoteParams): Promise<AdapterQuoteResult | null> {
    const chainId = params.fromChainId || params.inputToken.chainId;
    if (!this.supportsChain(chainId)) {
      return null;
    }

    try {
      const inputCoin = this.formatCoinType(params.inputToken.address);
      const outputCoin = this.formatCoinType(params.outputToken.address);

      const response = await this.client.post('/v2/sui/swap/calculate', {
        coinTypeA: inputCoin,
        coinTypeB: outputCoin,
        amount: params.inputAmount,
        byAmountIn: true,
        slippage: params.slippage / 100,
      });

      if (!response.data || response.data.code !== 0) {
        logger.warn('Cetus quote returned error', { data: response.data });
        return null;
      }

      const data = response.data.data;
      const outputAmount = data.estimatedAmountOut || data.amountOut;

      return {
        outputAmount,
        minimumOutput: this.calculateMinOutput(outputAmount, params.slippage),
        estimatedTime: 5, // Sui is very fast
        priceImpact: (data.priceImpact || 0) * 100,
        route: [{
          type: 'SWAP' as const,
          protocol: 'Cetus',
          chainId,
          inputToken: params.inputToken,
          outputToken: params.outputToken,
          inputAmount: params.inputAmount,
          expectedOutput: outputAmount,
          minimumOutput: this.calculateMinOutput(outputAmount, params.slippage),
          estimatedTime: 5,
        }],
      };
    } catch (error: any) {
      logger.error('Cetus quote error', { error: error.response?.data || error.message });
      return null;
    }
  }

  private calculateMinOutput(outputAmount: string, slippagePercent: number): string {
    const amount = BigInt(outputAmount);
    const slippageBps = BigInt(Math.round(slippagePercent * 100));
    const minOutput = amount - (amount * slippageBps / 10000n);
    return minOutput.toString();
  }

  async buildTransaction(
    params: AdapterQuoteParams,
    quote: AdapterQuoteResult
  ): Promise<{ to: string; data: string; value: string; gasLimit?: string }> {
    throw new Error('Cetus requires Sui-specific transaction building');
  }
}
