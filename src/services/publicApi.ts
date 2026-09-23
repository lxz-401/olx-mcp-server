import type { Page } from "playwright-core";
import { LANG, OLX_BASE_URL, PUBLIC_API_PATH } from "../constants.js";
import { OlxApiError } from "../errors.js";
import { getBrowser, onBrowserClose, touchBrowser } from "./browser.js";

/** Anonim (akkauntsiz) context — raqobatchilar va bozor tahlili so'rovlari akkauntga bog'lanmaydi. */
let pagePromise: Promise<Page> | undefined;
onBrowserClose(() => {
  pagePromise = undefined;
});

async function openPage(): Promise<Page> {
  const browser = await getBrowser();
  const context = await browser.newContext({ locale: LANG, extraHTTPHeaders: { "Accept-Language": LANG } });
  const page = await context.newPage();
  // Yengil JSON sahifa — origin va cookie'larni o'rnatish uchun yetarli.
  await page.goto(`${OLX_BASE_URL}${PUBLIC_API_PATH}/offers/?limit=1`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  return page;
}

async function getPage(): Promise<Page> {
  if (pagePromise) {
    const page = await pagePromise.catch(() => undefined);
    if (page && !page.isClosed()) return page;
  }
  pagePromise = openPage();
  pagePromise.catch(() => {
    pagePromise = undefined;
  });
  return pagePromise;
}

export type PublicQuery = Record<string, string | number | undefined>;

/** `/api/v1{path}` ga anonim GET so'rov yuboradi va JSON qaytaradi. */
export async function publicGet<T>(path: string, query: PublicQuery = {}): Promise<T> {
  const url = new URL(`${OLX_BASE_URL}${PUBLIC_API_PATH}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await getPage();
    const result = await page.evaluate(async (target: string) => {
      const response = await fetch(target, { headers: { Accept: "application/json" }, credentials: "include" });
      return { status: response.status, text: await response.text() };
    }, url.toString());
    touchBrowser();

    const blocked = result.status === 403 && result.text.trimStart().startsWith("<");
    if (blocked && attempt === 0) {
      pagePromise = undefined;
      continue;
    }
    if (result.status >= 400) {
      throw new OlxApiError(
        blocked ? "OLX so'rovni blokladi (bot himoyasi). Birozdan so'ng qayta urinib ko'ring." : result.text.slice(0, 300),
        result.status,
      );
    }
    try {
      return JSON.parse(result.text) as T;
    } catch {
      throw new OlxApiError("OLX JSON o'rniga boshqa javob qaytardi.", result.status);
    }
  }
  throw new OlxApiError("OLX so'rovni blokladi.", 403);
}
