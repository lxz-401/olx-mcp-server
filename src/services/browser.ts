import { chromium, type Browser, type LaunchOptions } from "playwright-core";
import { BROWSER_IDLE_CLOSE_MS } from "../constants.js";

/**
 * Bitta umumiy headless Chrome/Edge. OLX saytining API'lari CloudFront orqali oddiy HTTP klientlarni
 * bloklaydi, shuning uchun olx.uz so'rovlari brauzer ichidan yuboriladi. Brauzer birinchi so'rovda
 * ishga tushadi va BROWSER_IDLE_CLOSE_MS davomida ishlatilmasa yopiladi.
 */

let browserPromise: Promise<Browser> | undefined;
let idleTimer: NodeJS.Timeout | undefined;
const closeListeners = new Set<() => void>();

export const STEALTH_ARGS = ["--disable-blink-features=AutomationControlled"];

export async function launchChromium(headless: boolean): Promise<Browser> {
  const options: LaunchOptions = { headless, args: STEALTH_ARGS };
  if (process.env.OLX_BROWSER_PATH) return chromium.launch({ ...options, executablePath: process.env.OLX_BROWSER_PATH });

  const channels = process.env.OLX_BROWSER_CHANNEL ? [process.env.OLX_BROWSER_CHANNEL] : ["chrome", "msedge"];
  const failures: string[] = [];
  for (const channel of channels) {
    try {
      return await chromium.launch({ ...options, channel });
    } catch (error) {
      failures.push(`${channel}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new Error(
    "Google Chrome yoki Microsoft Edge topilmadi. Chrome o'rnating yoki OLX_BROWSER_PATH ga brauzer yo'lini yozing. " +
      failures.join("; "),
  );
}

export async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => undefined);
    if (existing?.isConnected()) return existing;
  }
  browserPromise = launchChromium(process.env.OLX_HEADLESS === "false" ? false : true);
  browserPromise.catch(() => {
    browserPromise = undefined;
  });
  return browserPromise;
}

/** Har bir brauzer ishlatilganda chaqiriladi — bo'sh turish taymerini qayta boshlaydi. */
export function touchBrowser(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void closeBrowser(), BROWSER_IDLE_CLOSE_MS);
  idleTimer.unref();
}

/** Brauzer yopilganda keshlangan context/page larni tozalash uchun. */
export function onBrowserClose(listener: () => void): void {
  closeListeners.add(listener);
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  const current = browserPromise;
  browserPromise = undefined;
  for (const listener of closeListeners) listener();
  const browser = await current?.catch(() => undefined);
  await browser?.close().catch(() => undefined);
}
