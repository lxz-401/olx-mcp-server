import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { describeError } from "../errors.js";

export const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Javob formati: 'markdown' (o'qish uchun) yoki 'json' (to'liq tuzilgan ma'lumot)");

export type ResponseFormat = z.infer<typeof responseFormatSchema>;

function clip(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n…[Javob ${CHARACTER_LIMIT} belgida qirqildi. limit/offset yoki filtrlar bilan torroq so'rov yuboring.]`
  );
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text: clip(text) }] };
}

/** format === "json" bo'lsa `data` ni, aks holda `markdown()` natijasini qaytaradi. */
export function formatted(format: ResponseFormat, data: unknown, markdown: () => string): CallToolResult {
  return textResult(format === "json" ? JSON.stringify(data, null, 2) : markdown());
}

export function errorResult(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: describeError(error) }] };
}

/** Tool handlerini xatolarni ushlaydigan qilib o'raydi. */
export function safe<A>(handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

const CURRENCY_LABELS: Record<string, string> = { UZS: "so'm", UYE: "y.e.", USD: "$" };

export function money(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const rounded = Math.round(value).toLocaleString("ru-RU").replace(/ /g, " ");
  return `${rounded} ${CURRENCY_LABELS[currency ?? ""] ?? currency ?? ""}`.trim();
}

export function percent(part: number, total: number): string {
  return total ? `${Math.round((part / total) * 100)}%` : "—";
}

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

export function shortDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}
