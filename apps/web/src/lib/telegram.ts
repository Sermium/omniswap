// apps/web/src/lib/telegram.ts
//
// Server-side Telegram notifications (operator-facing: payments, listings,
// failures). Credentials come from env only - never from a committed file,
// since this repo is public and a leaked bot token gets auto-revoked.
//
// Design rule: notifying must NEVER break the thing it is reporting on. Every
// function here swallows its own errors and returns a result object, so a
// Telegram outage can't fail a customer's payment.

const TELEGRAM_API = 'https://api.telegram.org';

export type TelegramSendResult = { sent: boolean; reason?: string };

// Telegram MarkdownV2 reserves these; leaving any unescaped causes a 400 and a
// silently lost notification.
const RESERVED_MARKDOWN_CHARS = new Set([
  '_', '*', '[', ']', '(', ')', '~', '`', '>', '#',
  '+', '-', '=', '|', '{', '}', '.', '!', '\\',
]);

export function escapeMarkdown(text: string): string {
  let out = '';
  for (const ch of text) {
    out += RESERVED_MARKDOWN_CHARS.has(ch) ? '\\' + ch : ch;
  }
  return out;
}

function getConfig(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
}

/** True when Telegram notifications are configured for this deployment. */
export function isTelegramConfigured(): boolean {
  return getConfig() !== null;
}

export async function sendTelegramMessage(
  text: string,
  options: { chatId?: string; markdown?: boolean } = {}
): Promise<TelegramSendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return { sent: false, reason: 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: options.markdown === false ? undefined : 'MarkdownV2',
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, reason: `Telegram API ${res.status}: ${body.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (error: any) {
    return { sent: false, reason: error?.message || 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget operator notification. Never throws, so it is safe to call
 * from inside a payment or booking flow.
 */
export async function notifyOperator(
  title: string,
  lines: Array<[string, string | number | null | undefined]> = []
): Promise<TelegramSendResult> {
  try {
    const body = lines
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([label, value]) => `*${escapeMarkdown(label)}:* ${escapeMarkdown(String(value))}`)
      .join('\n');

    const text = `*${escapeMarkdown(title)}*${body ? `\n${body}` : ''}`;
    return await sendTelegramMessage(text);
  } catch (error: any) {
    // sendTelegramMessage already catches; this guarantees nothing escapes
    // into a caller's transaction even if message building itself throws.
    return { sent: false, reason: error?.message || 'unknown error' };
  }
}
