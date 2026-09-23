import { homedir } from "node:os";
import { join } from "node:path";

/** OLX sayti (default: O'zbekiston). Boshqa mamlakat uchun OLX_BASE_URL va OLX_SITE_CODE ni o'zgartiring. */
export const OLX_BASE_URL = (process.env.OLX_BASE_URL ?? "https://www.olx.uz").replace(/\/+$/, "");
export const OLX_SITE_CODE = process.env.OLX_SITE_CODE ?? "olxuz";

/** Saytning API'lari. */
export const PUBLIC_API_PATH = "/api/v1";
export const GRAPHQL_URL = "https://production-graphql.eu-sharedservices.olxcdn.com/graphql";
export const CATEGORIES_URL = "https://categories.olxcdn.com/posting/v1/categories";
export const PUBLIC_PAGE_SIZE = 50; // OLX maksimal limit
export const PUBLIC_MAX_OFFSET = 1000; // OLX qidiruvi 1000 tadan ortiq natija bermaydi

export const LANG = process.env.OLX_LANG ?? "ru";
/** Brauzer sessiyasi (cookie'lar) — `npm run login` yoki `olx_login` orqali yaratiladi. */
export const SESSION_FILE = process.env.OLX_SESSION_FILE ?? join(homedir(), ".olx-mcp", "session.json");

export const REQUEST_TIMEOUT_MS = 30_000;
export const BROWSER_IDLE_CLOSE_MS = 120_000;
export const CHARACTER_LIMIT = 25_000;
