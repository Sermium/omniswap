import { PrismaClient, AlertType, PriceAlert, Prisma } from '@prisma/client';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { logger } from '../utils/logger';
import { PriceService } from './price.service';
import { NotificationService } from './notification.service';

// ============================================================================
// Types
// ============================================================================

export interface CreateAlertInput {
  userId: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  tokenLogoURI?: string;
  chainId: number;
  type: 'above' | 'below' | 'percent_change';
  targetPrice?: number;
  percentChange?: number;
  isRecurring?: boolean;
  cooldownMinutes?: number;
  notifyEmail?: boolean;
  notifyPush?: boolean;
  notifyTelegram?: boolean;
  telegramChatId?: string;
  note?: string;
}

export interface UpdateAlertInput {
  type?: 'above' | 'below' | 'percent_change';
  targetPrice?: number;
  percentChange?: number;
  isEnabled?: boolean;
  isRecurring?: boolean;
  cooldownMinutes?: number;
  notifyEmail?: boolean;
  notifyPush?: boolean;
  notifyTelegram?: boolean;
  telegramChatId?: string;
  note?: string;
}

export interface AlertWithPrice extends PriceAlert {
  currentPrice: number;
}

export interface AlertStats {
  totalAlerts: number;
  activeAlerts: number;
  triggeredToday: number;
  triggeredTotal: number;
}

export interface AlertHistoryItem {
  id: string;
  alertId: string;
  tokenSymbol: string;
  tokenLogoURI: string | null;
  chainId: number;
  type: string;
  targetPrice: number | null;
  percentChange: number | null;
  triggeredPrice: number;
  notificationsSent: string[];
  triggeredAt: Date;
}

// ============================================================================
// Alert Service
// ============================================================================

export class AlertService {
  private prisma: PrismaClient;
  private redis: Redis;
  private priceService: PriceService;
  private notificationService: NotificationService;
  private alertCheckQueue: Queue;

  // Cache TTLs
  private readonly PRICE_CACHE_TTL = 10; // 10 seconds
  private readonly STATS_CACHE_TTL = 30; // 30 seconds

  constructor(
    prisma: PrismaClient,
    redis: Redis,
    priceService: PriceService,
    notificationService: NotificationService,
    alertCheckQueue: Queue
  ) {
    this.prisma = prisma;
    this.redis = redis;
    this.priceService = priceService;
    this.notificationService = notificationService;
    this.alertCheckQueue = alertCheckQueue;
  }

  // --------------------------------------------------------------------------
  // CRUD Operations
  // --------------------------------------------------------------------------

  async createAlert(input: CreateAlertInput): Promise<AlertWithPrice> {
    const {
      userId,
      tokenAddress,
      tokenSymbol,
      tokenName,
      tokenLogoURI,
      chainId,
      type,
      targetPrice,
      percentChange,
      isRecurring = false,
      cooldownMinutes = 0,
      notifyEmail = true,
      notifyPush = true,
      notifyTelegram = false,
      telegramChatId,
      note,
    } = input;

    // Validate alert type and target
    if (type === 'percent_change' && percentChange === undefined) {
      throw new Error('percentChange is required for percent_change alerts');
    }
    if (type !== 'percent_change' && targetPrice === undefined) {
      throw new Error('targetPrice is required for above/below alerts');
    }

    // Get current price for basePrice
    const currentPrice = await this.priceService.getTokenPrice(chainId, tokenAddress);
    if (!currentPrice) {
      throw new Error('Unable to fetch current token price');
    }

    // Check for duplicate alerts
    const existingAlert = await this.prisma.priceAlert.findFirst({
      where: {
        userId,
        chainId,
        tokenAddress: tokenAddress.toLowerCase(),
        type: this.maptype(type),
        targetPrice: targetPrice ? new Prisma.Decimal(targetPrice) : undefined,
        percentChange: percentChange ? new Prisma.Decimal(percentChange) : undefined,
        isEnabled: true,
      },
    });

    if (existingAlert) {
      throw new Error('A similar alert already exists');
    }

    // Create the alert
    const alert = await this.prisma.priceAlert.create({
      data: {
        userId,
        tokenAddress: tokenAddress.toLowerCase(),
        tokenSymbol,
        tokenName,
        tokenLogoURI,
        chainId,
        type: this.maptype(type),
        targetPrice: targetPrice ? new Prisma.Decimal(targetPrice) : null,
        percentChange: percentChange ? new Prisma.Decimal(percentChange) : null,
        basePrice: new Prisma.Decimal(currentPrice),
        isRecurring,
        cooldownMinutes,
        notifyEmail,
        notifyPush,
        notifyTelegram,
        telegramChatId,
        note,
      },
    });

    // Invalidate stats cache
    await this.invalidateStatsCache(userId);

    // Schedule immediate check for this alert
    await this.alertCheckQueue.add(
      'check-alert',
      { alertId: alert.id },
      { delay: 1000 }
    );

    logger.info('Alert created', { alertId: alert.id, userId, tokenSymbol, type });

    return this.enrichAlertWithPrice(alert);
  }

  async updateAlert(alertId: string, userId: string, input: UpdateAlertInput): Promise<AlertWithPrice> {
    // Verify ownership
    const existing = await this.prisma.priceAlert.findFirst({
      where: { id: alertId, userId },
    });

    if (!existing) {
      throw new Error('Alert not found');
    }

    // Build update data
    const updateData: Prisma.PriceAlertUpdateInput = {};

    if (input.type !== undefined) {
      updateData.type = this.maptype(input.type);
    }
    if (input.targetPrice !== undefined) {
      updateData.targetPrice = new Prisma.Decimal(input.targetPrice);
    }
    if (input.percentChange !== undefined) {
      updateData.percentChange = new Prisma.Decimal(input.percentChange);
    }
    if (input.isEnabled !== undefined) {
      updateData.isEnabled = input.isEnabled;
    }
    if (input.isRecurring !== undefined) {
      updateData.isRecurring = input.isRecurring;
    }
    if (input.cooldownMinutes !== undefined) {
      updateData.cooldownMinutes = input.cooldownMinutes;
    }
    if (input.notifyEmail !== undefined) {
      updateData.notifyEmail = input.notifyEmail;
    }
    if (input.notifyPush !== undefined) {
      updateData.notifyPush = input.notifyPush;
    }
    if (input.notifyTelegram !== undefined) {
      updateData.notifyTelegram = input.notifyTelegram;
    }
    if (input.telegramChatId !== undefined) {
      updateData.telegramChatId = input.telegramChatId;
    }
    if (input.note !== undefined) {
      updateData.note = input.note;
    }

    const alert = await this.prisma.priceAlert.update({
      where: { id: alertId },
      data: updateData,
    });

    // Invalidate stats cache
    await this.invalidateStatsCache(userId);

    logger.info('Alert updated', { alertId, userId });

    return this.enrichAlertWithPrice(alert);
  }

  async deleteAlert(alertId: string, userId: string): Promise<void> {
    // Verify ownership
    const existing = await this.prisma.priceAlert.findFirst({
      where: { id: alertId, userId },
    });

    if (!existing) {
      throw new Error('Alert not found');
    }

    await this.prisma.priceAlert.delete({
      where: { id: alertId },
    });

    // Invalidate stats cache
    await this.invalidateStatsCache(userId);

    logger.info('Alert deleted', { alertId, userId });
  }

  async getAlert(alertId: string, userId: string): Promise<AlertWithPrice | null> {
    const alert = await this.prisma.priceAlert.findFirst({
      where: { id: alertId, userId },
    });

    if (!alert) {
      return null;
    }

    return this.enrichAlertWithPrice(alert);
  }

  async getUserAlerts(userId: string): Promise<AlertWithPrice[]> {
    const alerts = await this.prisma.priceAlert.findMany({
      where: { userId },
      orderBy: [
        { isEnabled: 'desc' },
        { createdAt: 'desc' },
      ],
    });

    return Promise.all(alerts.map((alert) => this.enrichAlertWithPrice(alert)));
  }

  // --------------------------------------------------------------------------
  // Stats & History
  // --------------------------------------------------------------------------

  async getAlertStats(userId: string): Promise<AlertStats> {
    const cacheKey = `alert:stats:${userId}`;
    const cached = await this.redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalAlerts, activeAlerts, triggeredToday, triggeredTotal] = await Promise.all([
      this.prisma.priceAlert.count({ where: { userId } }),
      this.prisma.priceAlert.count({ where: { userId, isEnabled: true } }),
      this.prisma.alertHistory.count({
        where: {
          alert: { userId },
          triggeredAt: { gte: today },
        },
      }),
      this.prisma.alertHistory.count({
        where: { alert: { userId } },
      }),
    ]);

    const stats: AlertStats = {
      totalAlerts,
      activeAlerts,
      triggeredToday,
      triggeredTotal,
    };

    await this.redis.setex(cacheKey, this.STATS_CACHE_TTL, JSON.stringify(stats));

    return stats;
  }

  async getAlertHistory(
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<AlertHistoryItem[]> {
    const history = await this.prisma.alertHistory.findMany({
      where: { alert: { userId } },
      orderBy: { triggeredAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return history.map((item) => ({
      id: item.id,
      alertId: item.alertId,
      tokenSymbol: item.tokenSymbol,
      tokenLogoURI: item.tokenLogoURI,
      chainId: item.chainId,
      type: item.type.toLowerCase(),
      targetPrice: item.targetPrice ? Number(item.targetPrice) : null,
      percentChange: item.percentChange ? Number(item.percentChange) : null,
      triggeredPrice: Number(item.triggeredPrice),
      notificationsSent: item.notificationsSent,
      triggeredAt: item.triggeredAt,
    }));
  }

  // --------------------------------------------------------------------------
  // Alert Checking & Triggering
  // --------------------------------------------------------------------------

  async checkAlert(alertId: string): Promise<boolean> {
    const alert = await this.prisma.priceAlert.findUnique({
      where: { id: alertId },
      include: { user: true },
    });

    if (!alert || !alert.isEnabled) {
      return false;
    }

    // Check cooldown
    if (alert.isRecurring && alert.triggeredAt) {
      const cooldownMs = alert.cooldownMinutes * 60 * 1000;
      const timeSinceLastTrigger = Date.now() - alert.triggeredAt.getTime();
      if (timeSinceLastTrigger < cooldownMs) {
        return false;
      }
    }

    // Get current price
    const currentPrice = await this.priceService.getTokenPrice(alert.chainId, alert.tokenAddress);
    if (!currentPrice) {
      logger.warn('Unable to fetch price for alert check', { alertId });
      return false;
    }

    // Check if alert should trigger
    const shouldTrigger = this.shouldAlertTrigger(alert, currentPrice);

    if (shouldTrigger) {
      await this.triggerAlert(alert, currentPrice);
      return true;
    }

    return false;
  }

  private shouldAlertTrigger(alert: PriceAlert, currentPrice: number): boolean {
    switch (alert.type) {
      case PRICE_ABOVE:
        return currentPrice >= Number(alert.targetPrice);

      case PRICE_BELOW:
        return currentPrice <= Number(alert.targetPrice);

      case PRICE_CHANGE_PERCENT: {
        const basePrice = Number(alert.basePrice);
        const percentChange = ((currentPrice - basePrice) / basePrice) * 100;
        const targetPercent = Number(alert.percentChange);

        if (targetPercent >= 0) {
          return percentChange >= targetPercent;
        } else {
          return percentChange <= targetPercent;
        }
      }

      default:
        return false;
    }
  }

  private async triggerAlert(alert: PriceAlert, currentPrice: number): Promise<void> {
    const notificationsSent: string[] = [];

    // Send notifications
    try {
      if (alert.notifyEmail) {
        await this.notificationService.sendEmailAlert(alert, currentPrice);
        notificationsSent.push('email');
      }
    } catch (error) {
      logger.error('Failed to send email notification', { alertId: alert.id, error });
    }

    try {
      if (alert.notifyPush) {
        await this.notificationService.sendPushAlert(alert, currentPrice);
        notificationsSent.push('push');
      }
    } catch (error) {
      logger.error('Failed to send push notification', { alertId: alert.id, error });
    }

    try {
      if (alert.notifyTelegram && alert.telegramChatId) {
        await this.notificationService.sendTelegramAlert(alert, currentPrice);
        notificationsSent.push('telegram');
      }
    } catch (error) {
      logger.error('Failed to send Telegram notification', { alertId: alert.id, error });
    }

    // Record in history
    await this.prisma.alertHistory.create({
      data: {
        alertId: alert.id,
        tokenSymbol: alert.tokenSymbol,
        tokenLogoURI: alert.tokenLogoURI,
        chainId: alert.chainId,
        type: alert.type,
        targetPrice: alert.targetPrice,
        percentChange: alert.percentChange,
        triggeredPrice: new Prisma.Decimal(currentPrice),
        notificationsSent,
      },
    });

    // Update alert
    if (alert.isRecurring) {
      await this.prisma.priceAlert.update({
        where: { id: alert.id },
        data: {
          triggeredAt: new Date(),
          triggerCount: { increment: 1 },
        },
      });
    } else {
      // Disable non-recurring alerts after trigger
      await this.prisma.priceAlert.update({
        where: { id: alert.id },
        data: {
          isEnabled: false,
          triggeredAt: new Date(),
          triggerCount: { increment: 1 },
        },
      });
    }

    // Invalidate stats cache
    await this.invalidateStatsCache(alert.userId);

    logger.info('Alert triggered', {
      alertId: alert.id,
      tokenSymbol: alert.tokenSymbol,
      currentPrice,
      notificationsSent,
    });
  }

  async checkAllActiveAlerts(): Promise<{ checked: number; triggered: number }> {
    const activeAlerts = await this.prisma.priceAlert.findMany({
      where: { isEnabled: true },
      select: { id: true },
    });

    let triggered = 0;

    for (const alert of activeAlerts) {
      const wasTriggered = await this.checkAlert(alert.id);
      if (wasTriggered) triggered++;
    }

    logger.info('Alert check completed', { checked: activeAlerts.length, triggered });

    return { checked: activeAlerts.length, triggered };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async enrichAlertWithPrice(alert: PriceAlert): Promise<AlertWithPrice> {
    const cacheKey = `price:${alert.chainId}:${alert.tokenAddress}`;
    let currentPrice: number;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      currentPrice = parseFloat(cached);
    } else {
      currentPrice = (await this.priceService.getTokenPrice(alert.chainId, alert.tokenAddress)) || 0;
      if (currentPrice > 0) {
        await this.redis.setex(cacheKey, this.PRICE_CACHE_TTL, currentPrice.toString());
      }
    }

    return {
      ...alert,
      currentPrice,
    };
  }

  private maptype(type: 'above' | 'below' | 'percent_change'): type {
    switch (type) {
      case 'above':
        return PRICE_ABOVE;
      case 'below':
        return PRICE_BELOW;
      case 'percent_change':
        return PRICE_CHANGE_PERCENT;
    }
  }

  private async invalidateStatsCache(userId: string): Promise<void> {
    await this.redis.del(`alert:stats:${userId}`);
  }
}
