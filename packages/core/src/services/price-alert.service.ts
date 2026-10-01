// packages/core/src/services/price-alert.service.ts
import { prisma } from '../lib/prisma';
import { redis } from '../utils/redis';
import { PriceService } from './price.service';
import { NotificationService } from './notification.service';
import { EventEmitter } from 'events';

export interface CreateAlertInput {
  userId: string;
  chainId: string;
  tokenAddress: string;
  tokenSymbol: string;
  type: 'PRICE_ABOVE' | 'PRICE_BELOW' | 'PRICE_CHANGE_PERCENT';
  targetPrice: number;
  notifyEmail?: boolean;
  notifyPush?: boolean;
  notifyTelegram?: boolean;
  telegramChatId?: string;
  isRecurring?: boolean;
  cooldownMinutes?: number;
  note?: string;
}

export interface PriceAlert {
  id: string;
  userId: string;
  chainId: string;
  tokenAddress: string;
  tokenSymbol: string;
  type: 'PRICE_ABOVE' | 'PRICE_BELOW' | 'PRICE_CHANGE_PERCENT';
  targetPrice: number;
  currentPrice?: number;
  status: 'ACTIVE' | 'TRIGGERED' | 'DISABLED';
  triggeredAt?: Date;
  notifyEmail: boolean;
  notifyPush: boolean;
  notifyTelegram: boolean;
  isRecurring: boolean;
  cooldownMinutes: number;
  note?: string;
  createdAt: Date;
}

export class PriceAlertService extends EventEmitter {
  private priceService: PriceService;
  private notificationService: NotificationService;
  private checkInterval: NodeJS.Timeout | null = null;
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();

  constructor(priceService: PriceService, notificationService: NotificationService) {
    super();
    this.priceService = priceService;
    this.notificationService = notificationService;
  }

  /**
   * Create a new price alert
   */
  async createAlert(input: CreateAlertInput): Promise<PriceAlert> {
    // Get current price
    const currentPrice = await this.priceService.getTokenPriceUsd(
      input.chainId,
      input.tokenAddress
    );

    // Validate alert makes sense
    if (input.type === 'PRICE_ABOVE' && currentPrice && currentPrice >= input.targetPrice) {
      throw new Error('Target price must be above current price for PRICE_ABOVE alerts');
    }

    if (input.type === 'PRICE_BELOW' && currentPrice && currentPrice <= input.targetPrice) {
      throw new Error('Target price must be below current price for PRICE_BELOW alerts');
    }

    const alert = await prisma.priceAlert.create({
      data: {
        userId: input.userId,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress.toLowerCase(),
        tokenSymbol: input.tokenSymbol,
        type: input.type,
        targetPrice: input.targetPrice,
        currentPrice,
        status: 'ACTIVE',
        notifyEmail: input.notifyEmail ?? true,
        notifyPush: input.notifyPush ?? true,
        notifyTelegram: input.notifyTelegram ?? false,
        telegramChatId: input.telegramChatId,
        isRecurring: input.isRecurring ?? false,
        cooldownMinutes: input.cooldownMinutes ?? 60,
        note: input.note,
      },
    });

    // Cache for quick checking
    await this.cacheAlert(alert);

    this.emit('alertCreated', alert);

    return alert as unknown as PriceAlert;
  }

  /**
   * Update an alert
   */
  async updateAlert(
    alertId: string,
    userId: string,
    updates: Partial<CreateAlertInput>
  ): Promise<PriceAlert> {
    const alert = await prisma.priceAlert.findFirst({
      where: { id: alertId, userId },
    });

    if (!alert) {
      throw new Error('Alert not found');
    }

    const updated = await prisma.priceAlert.update({
      where: { id: alertId },
      data: updates,
    });

    await this.cacheAlert(updated);

    return updated as unknown as PriceAlert;
  }

  /**
   * Delete an alert
   */
  async deleteAlert(alertId: string, userId: string): Promise<void> {
    const alert = await prisma.priceAlert.findFirst({
      where: { id: alertId, userId },
    });

    if (!alert) {
      throw new Error('Alert not found');
    }

    await prisma.priceAlert.delete({ where: { id: alertId } });
    await this.uncacheAlert(alert);
  }

  /**
   * Get user's alerts
   */
  async getUserAlerts(
    userId: string,
    options: {
      status?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ alerts: PriceAlert[]; total: number }> {
    const where: any = { userId };
    
    if (options.status) {
      where.status = options.status;
    }

    const [alerts, total] = await Promise.all([
      prisma.priceAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: options.limit || 50,
        skip: options.offset || 0,
      }),
      prisma.priceAlert.count({ where }),
    ]);

    // Enrich with current prices
    const enriched = await Promise.all(
      alerts.map(async (alert) => {
        const currentPrice = await this.priceService.getTokenPriceUsd(
          alert.chainId,
          alert.tokenAddress
        );
        return { ...alert, currentPrice } as unknown as PriceAlert;
      })
    );

    return { alerts: enriched, total };
  }

  /**
   * Check all active alerts
   */
  async checkAlerts(): Promise<void> {
    // Get all active alerts grouped by token
    const activeAlerts = await prisma.priceAlert.findMany({
      where: { status: 'ACTIVE' },
    });

    // Group by token for efficient price fetching
    const alertsByToken = new Map<string, typeof activeAlerts>();
    
    for (const alert of activeAlerts) {
      const key = `${alert.chainId}:${alert.tokenAddress}`;
      const existing = alertsByToken.get(key) || [];
      existing.push(alert);
      alertsByToken.set(key, existing);
    }

    // Check each token
    for (const [key, alerts] of alertsByToken) {
      const [chainId, tokenAddress] = key.split(':');
      
      try {
        // Get current price (with caching)
        const currentPrice = await this.getCachedPrice(chainId, tokenAddress);
        
        if (currentPrice === null) continue;

        // Check each alert for this token
        for (const alert of alerts) {
          await this.checkAlert(alert, currentPrice);
        }
      } catch (error) {
        console.error(`Error checking alerts for ${key}:`, error);
      }
    }
  }

  /**
   * Check single alert against current price
   */
  private async checkAlert(alert: any, currentPrice: number): Promise<void> {
    let triggered = false;

    switch (alert.type) {
      case 'PRICE_ABOVE':
        triggered = currentPrice >= alert.targetPrice;
        break;
      case 'PRICE_BELOW':
        triggered = currentPrice <= alert.targetPrice;
        break;
      case 'PRICE_CHANGE_PERCENT': {
        // For percent change, targetPrice represents the % change
        const basePrice = alert.currentPrice || currentPrice;
        const changePercent = ((currentPrice - basePrice) / basePrice) * 100;
        triggered = Math.abs(changePercent) >= alert.targetPrice;
        break;
      }
    }

    if (triggered) {
      // Check cooldown
      if (alert.lastNotifiedAt) {
        const cooldownMs = alert.cooldownMinutes * 60 * 1000;
        const timeSinceLastNotification = Date.now() - alert.lastNotifiedAt.getTime();
        
        if (timeSinceLastNotification < cooldownMs) {
          return; // Still in cooldown
        }
      }

      await this.triggerAlert(alert, currentPrice);
    }
  }

  /**
   * Trigger an alert
   */
  private async triggerAlert(alert: any, currentPrice: number): Promise<void> {
    // Get user
    const user = await prisma.user.findUnique({
      where: { id: alert.userId },
    });

    if (!user) return;

    // Send notifications
    const message = this.formatAlertMessage(alert, currentPrice);

    if (alert.notifyEmail && user.email) {
      await this.notificationService.sendEmail({
        to: user.email,
        subject: `Price Alert: ${alert.tokenSymbol}`,
        body: message,
      });
    }

    if (alert.notifyPush && user.pushToken) {
      await this.notificationService.sendPush({
        token: user.pushToken,
        title: `${alert.tokenSymbol} Price Alert`,
        body: message,
        data: {
          type: 'PRICE_ALERT',
          alertId: alert.id,
          tokenAddress: alert.tokenAddress,
          chainId: alert.chainId,
        },
      });
    }

    if (alert.notifyTelegram && alert.telegramChatId) {
      await this.notificationService.sendTelegram({
        chatId: alert.telegramChatId,
        message,
      });
    }

    // Update alert
    const updateData: any = {
      triggeredAt: new Date(),
      lastNotifiedAt: new Date(),
      currentPrice,
    };

    if (!alert.isRecurring) {
      updateData.status = 'TRIGGERED';
    }

    await prisma.priceAlert.update({
      where: { id: alert.id },
      data: updateData,
    });

    this.emit('alertTriggered', { alert, currentPrice });
  }

  /**
   * Format alert message
   */
  private formatAlertMessage(alert: any, currentPrice: number): string {
    const direction = currentPrice > (alert.currentPrice || 0) ? '📈' : '📉';
    const changePercent = alert.currentPrice 
      ? (((currentPrice - alert.currentPrice) / alert.currentPrice) * 100).toFixed(2)
      : '0';

    let condition = '';
    switch (alert.type) {
      case 'PRICE_ABOVE':
        condition = `reached $${currentPrice.toFixed(4)} (above $${alert.targetPrice})`;
        break;
      case 'PRICE_BELOW':
        condition = `dropped to $${currentPrice.toFixed(4)} (below $${alert.targetPrice})`;
        break;
      case 'PRICE_CHANGE_PERCENT':
        condition = `changed by ${changePercent}% (target: ${alert.targetPrice}%)`;
        break;
    }

    let message = `${direction} ${alert.tokenSymbol} ${condition}`;

    if (alert.note) {
      message += `\n\n📝 Note: ${alert.note}`;
    }

    return message;
  }

  /**
   * Get cached price or fetch new
   */
  private async getCachedPrice(chainId: string, tokenAddress: string): Promise<number | null> {
    const key = `${chainId}:${tokenAddress}`;
    const cached = this.priceCache.get(key);
    
    // Cache for 10 seconds
    if (cached && Date.now() - cached.timestamp < 10000) {
      return cached.price;
    }

    const price = await this.priceService.getTokenPriceUsd(chainId, tokenAddress);
    
    if (price !== null) {
      this.priceCache.set(key, { price, timestamp: Date.now() });
    }

    return price;
  }

  /**
   * Cache alert for quick lookup
   */
  private async cacheAlert(alert: any): Promise<void> {
    const key = `price-alert:${alert.chainId}:${alert.tokenAddress}`;
    await redis.sadd(key, alert.id);
  }

  /**
   * Remove alert from cache
   */
  private async uncacheAlert(alert: any): Promise<void> {
    const key = `price-alert:${alert.chainId}:${alert.tokenAddress}`;
    await redis.srem(key, alert.id);
  }

  /**
   * Start alert monitoring
   */
  startMonitoring(intervalMs: number = 30000): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(() => {
      this.checkAlerts().catch(console.error);
    }, intervalMs);

    console.log(`Price alert monitoring started (interval: ${intervalMs}ms)`);
  }

  /**
   * Stop alert monitoring
   */
  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('Price alert monitoring stopped');
    }
  }
}
