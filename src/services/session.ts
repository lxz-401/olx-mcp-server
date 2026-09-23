import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { GRAPHQL_URL, LANG, OLX_BASE_URL, OLX_SITE_CODE, REQUEST_TIMEOUT_MS, SESSION_FILE } from "../constants.js";
import { OlxApiError, OlxSessionError } from "../errors.js";
import { getBrowser, launchChromium, onBrowserClose, touchBrowser } from "./browser.js";

/**
 * Foydalanuvchining OLX sessiyasi (cookie'lar) orqali ishlash.
 *  - `access_token` cookie — 15 daqiqalik JWT. Eskirganda olx.uz sahifasi ochiladi va saytning o'z
 *    Auth0 SDK si uni login.olx.uz sessiyasi orqali yangilaydi.
 *  - olx.uz REST so'rovlari brauzer ichidan (CloudFront), GraphQL va rasm yuklash — to'g'ridan-to'g'ri Node'dan.
 */

const REFRESH_MARGIN_MS = 90_000;
const REFRESH_WAIT_MS = 25_000;
const REST_VERSION = "v1.19";

interface SessionState {
  context: BrowserContext;
  page: Page;
}

let statePromise: Promise<SessionState> | undefined;
onBrowserClose(() => {
  statePromise = undefined;
});

export function hasSessionFile(): boolean {
  return existsSync(SESSION_FILE);
}

function requireSessionFile(): void {
  if (!hasSessionFile()) {
    throw new OlxSessionError("OLX akkauntiga kirilmagan.");
  }
}

async function openSession(): Promise<SessionState> {
  requireSessionFile();
  const browser = await getBrowser();
  const context = await browser.newContext({ storageState: SESSION_FILE, locale: LANG });
  const page = await context.newPage();
  // HTML sahifa: saytning JS'i ishga tushib, kerak bo'lsa tokenni yangilaydi.
  await page.goto(`${OLX_BASE_URL}/myaccount/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  return { context, page };
}

async function getSession(): Promise<SessionState> {
  if (statePromise) {
    const state = await statePromise.catch(() => undefined);
    if (state && !state.page.isClosed()) return state;
  }
  statePromise = openSession();
  statePromise.catch(() => {
    statePromise = undefined;
  });
  return statePromise;
}

/** Login'dan keyin yangi session.json ni o'qish uchun keshni tozalaydi. */
export async function resetSession(): Promise<void> {
  const state = await statePromise?.catch(() => undefined);
  statePromise = undefined;
  await state?.context.close().catch(() => undefined);
}

export function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

async function readToken(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies(OLX_BASE_URL)).find((c) => c.name === "access_token" && c.value)?.value;
}

async function saveSession(context: BrowserContext): Promise<void> {
  await mkdir(dirname(SESSION_FILE), { recursive: true });
  await context.storageState({ path: SESSION_FILE });
}

/** Amal qiluvchi access token (kerak bo'lsa yangilanadi va session.json ga saqlanadi). */
export async function getAccessToken(): Promise<string> {
  const { context, page } = await getSession();
  touchBrowser();
  let token = await readToken(context);
  if (token && tokenExpiry(token) - REFRESH_MARGIN_MS > Date.now()) return token;

  await page.goto(`${OLX_BASE_URL}/myaccount/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const deadline = Date.now() + REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    token = await readToken(context);
    if (token && tokenExpiry(token) - REFRESH_MARGIN_MS > Date.now()) {
      await saveSession(context);
      return token;
    }
    await page.waitForTimeout(1000);
  }
  throw new OlxSessionError("Sessiya eskirgan yoki OLX'dan chiqilgan.");
}

interface RestOptions {
  body?: unknown;
  version?: string;
  headers?: Record<string, string>;
}

/** olx.uz `/api/v1{path}` ga foydalanuvchi nomidan so'rov (brauzer ichidan). */
export async function sessionRest<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, options: RestOptions = {}): Promise<T> {
  const token = await getAccessToken();
  const { page } = await getSession();
  const result = await page.evaluate(
    async ({ url, method, token, body, version, headers }) => {
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          Version: version,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, text: await response.text() };
    },
    { url: `${OLX_BASE_URL}/api/v1${path}`, method, token, body: options.body, version: options.version ?? REST_VERSION, headers: options.headers ?? {} },
  );
  touchBrowser();
  let parsed: unknown;
  try {
    parsed = result.text ? JSON.parse(result.text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (result.status >= 400) {
    if (result.status === 401) throw new OlxSessionError("OLX tokenni qabul qilmadi.");
    const err = (parsed as { error?: { detail?: string; title?: string; message?: string } | string } | undefined)?.error;
    const message = typeof err === "string" ? err : (err?.detail ?? err?.title ?? err?.message ?? result.text.slice(0, 300));
    throw new OlxApiError(message, result.status);
  }
  return parsed as T;
}

/** OLX GraphQL (Mening e'lonlarim va h.k.) — Node'dan to'g'ridan-to'g'ri. */
export async function graphql<T>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      site: OLX_SITE_CODE,
      "x-client": "DESKTOP",
      "accept-language": LANG,
    },
    body: JSON.stringify({ operationName, query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (response.status === 401) throw new OlxSessionError("OLX tokenni qabul qilmadi.");
  if (!response.ok || json.errors?.length) {
    throw new OlxApiError(json.errors?.map((e) => e.message).join("; ") || `GraphQL HTTP ${response.status}`, response.status);
  }
  return json.data as T;
}

/** Rasmni OLX'ning vaqtinchalik fayl omboriga yuklaydi va e'lon uchun `filename` qaytaradi. */
export async function uploadPhoto(data: Buffer, contentType: string): Promise<string> {
  const { data: apollo } = await sessionRest<{ data: { token: string } }>("POST", "/apollo/token/", { body: {} });
  const response = await fetch(apolloUploadUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${apollo.token}`, "Content-Type": contentType },
    body: new Uint8Array(data),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await response.json().catch(() => ({}))) as { data?: { filename?: string } };
  if (!response.ok || !json.data?.filename) {
    throw new OlxApiError(`Rasm yuklanmadi (HTTP ${response.status}).`, response.status);
  }
  return json.data.filename;
}

function apolloUploadUrl(): string {
  // Sayt kodi bo'yicha: olxua/pl/pt → ireland, olxkz → frankfurt2, qolganlari (olxuz) → frankfurt
  if (["olxua", "olxpl", "olxpt"].includes(OLX_SITE_CODE)) return "https://ireland.apollo.olxcdn.com/v1/temp-files";
  if (OLX_SITE_CODE === "olxkz") return "https://frankfurt2.apollo.olxcdn.com/v1/temp-files";
  return "https://frankfurt.apollo.olxcdn.com/v1/temp-files";
}

/**
 * Ko'rinadigan Chrome oynasini ochadi; foydalanuvchi o'zi OLX'ga kiradi. Kirish aniqlangach
 * cookie'lar SESSION_FILE ga saqlanadi. Parol yoki SMS kod dastur tomonidan kiritilmaydi.
 */
export async function interactiveLogin(timeoutMs: number, log: (msg: string) => void = () => undefined): Promise<boolean> {
  const browser = await launchChromium(false);
  try {
    const context = await browser.newContext({
      locale: LANG,
      viewport: null,
      storageState: hasSessionFile() ? SESSION_FILE : undefined,
    });
    const page = await context.newPage();
    await page.goto(`${OLX_BASE_URL}/myaccount/`, { waitUntil: "domcontentloaded" });
    log("Ochilgan Chrome oynasida OLX akkauntingizga kiring.");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && browser.isConnected()) {
      const token = await readToken(context).catch(() => undefined);
      if (token && tokenExpiry(token) > Date.now()) {
        await page.goto(`${OLX_BASE_URL}/myaccount/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        await page.waitForTimeout(2000);
        await saveSession(context);
        await resetSession();
        return true;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
