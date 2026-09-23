import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { graphql } from "../services/session.js";
import { formatted, money, percent, responseFormatSchema, safe, shortDate, textResult } from "../services/format.js";
import type { MyAd } from "../types.js";

// Saytning "Mening e'lonlarim" sahifasi ishlatadigan GraphQL so'rovlari (production-graphql.eu-sharedservices.olxcdn.com)

const AD_FIELDS = `
  id title status categoryId price priceType currency photos validTo activatedAt lastRefreshAt daysToExpire
  canRefreshForFree editable statusCause
  stats { views observed phones }
  messageCounters { total new }
  location { name }
  categoryLevels { id name level }
  vases { type name validTo }
`;

const INVENTORY_QUERY = `query Inventory($limit: Int, $offset: Int, $filters: MyAdsAdsFiltersInput, $sorting: MyAdsAdSortingInput) {
  myAds { ads(limit: $limit, offset: $offset, filters: $filters, sorting: $sorting) { totalCount items { ${AD_FIELDS} } } }
}`;

const AD_QUERY = `query Ad($adId: String!) {
  myAds { ad(adId: $adId) { id title categoryId status validTo photos price priceType currency
    stats { views observed phones } messageCounters { total new } vases { validTo } } }
}`;

const STATS_HISTORY_QUERY = `query StatsHistory($adId: String!) {
  myAds { statsHistory(adId: $adId) {
    period { from to }
    statistics { date page_views messages }
    paid_features { pushups topads { from to } }
  } }
}`;

const UPDATE_AD_MUTATION = `mutation UpdateAd($adId: Int, $action: MyAdsAction) {
  myAds { updateAd(adId: $adId, action: $action) { adId status message activateResult { status code } } }
}`;

const STATUSES = ["ACTIVE", "WAITING", "UNPAID", "FINISHED", "MODERATED"] as const;

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Faol",
  WAITING: "Kutilmoqda / moderatsiyada",
  UNPAID: "To'lov kutilmoqda",
  FINISHED: "Yakunlangan (arxiv)",
  MODERATED: "Moderator rad etgan",
};

interface StatsHistory {
  period?: { from: string; to: string };
  statistics?: { date: string; page_views: number; messages: number }[];
  paid_features?: { pushups?: unknown; topads?: { from: string; to: string }[] };
}

export async function getMyAd(adId: string | number): Promise<MyAd | null> {
  const data = await graphql<{ myAds: { ad: MyAd | null } }>("Ad", AD_QUERY, { adId: String(adId) });
  return data.myAds.ad;
}

export async function listMyAds(status: string, limit: number, offset: number, query = ""): Promise<{ totalCount: number; items: MyAd[] }> {
  const data = await graphql<{ myAds: { ads: { totalCount: number; items: MyAd[] } } }>("Inventory", INVENTORY_QUERY, {
    limit,
    offset,
    filters: { query, status },
    sorting: { field: "createdAt", direction: "desc" },
  });
  return data.myAds.ads;
}

function adMarkdown(ad: MyAd): string {
  const s = ad.stats;
  const lines = [
    `## ${ad.title} (ID ${ad.id})`,
    `- Holati: **${STATUS_LABELS[ad.status] ?? ad.status}**${ad.statusCause ? ` (${ad.statusCause})` : ""}`,
    `- Narx: ${ad.price !== null && ad.price !== undefined ? money(ad.price, ad.currency) : "—"}${ad.priceType && ad.priceType !== "price" ? ` · ${ad.priceType}` : ""}`,
    `- Kategoriya: ${ad.categoryLevels?.map((c) => c.name).join(" › ") || ad.categoryId || "—"} · ${ad.location?.name ?? ""}`,
    `- Faollashtirilgan: ${shortDate(ad.activatedAt)} · amal qiladi: ${shortDate(ad.validTo)}${ad.daysToExpire !== null && ad.daysToExpire !== undefined ? ` (${ad.daysToExpire} kun qoldi)` : ""}`,
    `- Rasmlar: ${ad.photos?.length ?? 0}${ad.vases?.length ? ` · pullik xizmatlar: ${ad.vases.map((v) => v.name ?? v.type).join(", ")}` : ""}`,
  ];
  if (s) {
    lines.push(
      `- Statistika: 👁 ${s.views ?? 0} ko'rish · 📞 ${s.phones ?? 0} telefon (${percent(s.phones ?? 0, s.views ?? 0)}) · ⭐ ${s.observed ?? 0} saqlagan` +
        (ad.messageCounters ? ` · 💬 ${ad.messageCounters.total} xabar (${ad.messageCounters.new} yangi)` : ""),
    );
  }
  return lines.join("\n");
}

export function registerMyAdsTools(server: McpServer): void {
  server.registerTool(
    "olx_list_my_adverts",
    {
      title: "Mening e'lonlarim",
      description: `List the logged-in account's adverts by status with performance stats (views, phone views, saves, messages).

Args:
  - status: ACTIVE (default) | WAITING | UNPAID | FINISHED | MODERATED | ALL (all statuses)
  - query: filter by title text
  - limit (1–50), offset: pagination
  - response_format: markdown | json

Returns per advert: id, title, status, price, currency, category path, location, dates, days to expire, photos count,
stats {views, phones, observed}, message counters, paid features. Sorted newest first; markdown adds totals and conversion.`,
      inputSchema: {
        status: z.enum([...STATUSES, "ALL"]).default("ACTIVE"),
        query: z.string().max(100).default("").describe("Sarlavha bo'yicha filtr"),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ status, query, limit, offset, response_format }) => {
      const statuses = status === "ALL" ? [...STATUSES] : [status];
      const pages = await Promise.all(statuses.map((s) => listMyAds(s, limit, offset, query)));
      const items = pages.flatMap((p) => p.items);
      const total = pages.reduce((sum, p) => sum + p.totalCount, 0);
      const totals = items.reduce(
        (acc, ad) => ({
          views: acc.views + (ad.stats?.views ?? 0),
          phones: acc.phones + (ad.stats?.phones ?? 0),
          observed: acc.observed + (ad.stats?.observed ?? 0),
        }),
        { views: 0, phones: 0, observed: 0 },
      );
      const hasMore = pages.some((p) => p.totalCount > offset + p.items.length);
      const data = { total, count: items.length, offset, has_more: hasMore, next_offset: hasMore ? offset + limit : undefined, totals, adverts: items };

      return formatted(response_format, data, () => {
        if (!items.length) {
          return status === "ALL" ? "Akkauntda e'lonlar yo'q." : `${status} holatida e'lon yo'q. Barcha holatlar uchun status='ALL' bering.`;
        }
        const sorted = [...items].sort((a, b) => (b.stats?.views ?? 0) - (a.stats?.views ?? 0));
        return [
          `# Mening e'lonlarim — ${status} (${items.length} / ${total})`,
          `Jami: 👁 ${totals.views} ko'rish · 📞 ${totals.phones} telefon (${percent(totals.phones, totals.views)}) · ⭐ ${totals.observed} saqlagan`,
          "",
          ...sorted.map((ad) => adMarkdown(ad) + "\n"),
          hasMore ? `Keyingi sahifa: offset=${offset + limit}` : "",
        ].join("\n");
      });
    }),
  );

  server.registerTool(
    "olx_get_my_advert",
    {
      title: "E'lon statistikasi",
      description: `Get one of the account's adverts with totals (views, phone views, saves, messages) and the DAILY statistics history
(page views and messages per day) plus paid promotions history. Use to see how an advert's traffic changes over time.`,
      inputSchema: {
        advert_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).describe("E'lon ID si (olx_list_my_adverts dan)"),
        response_format: responseFormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ advert_id, response_format }) => {
      const [ad, history] = await Promise.all([
        getMyAd(advert_id),
        graphql<{ myAds: { statsHistory: StatsHistory | null } }>("StatsHistory", STATS_HISTORY_QUERY, { adId: String(advert_id) })
          .then((d) => d.myAds.statsHistory)
          .catch(() => null),
      ]);
      if (!ad) return { isError: true, content: [{ type: "text", text: `E'lon ${advert_id} topilmadi yoki sizga tegishli emas.` }] };
      return formatted(response_format, { ad, stats_history: history }, () => {
        const lines = [adMarkdown(ad)];
        const days = history?.statistics ?? [];
        if (days.length) {
          lines.push("", `## Kunlik statistika (${shortDate(history?.period?.from)} → ${shortDate(history?.period?.to)})`);
          for (const d of days.slice(-30)) lines.push(`- ${shortDate(d.date)}: 👁 ${d.page_views} · 💬 ${d.messages}`);
        }
        if (history?.paid_features?.topads?.length) {
          lines.push("", `TOP reklama davrlari: ${history.paid_features.topads.map((t) => `${shortDate(t.from)}→${shortDate(t.to)}`).join(", ")}`);
        }
        return lines.join("\n");
      });
    }),
  );

  server.registerTool(
    "olx_advert_action",
    {
      title: "E'lonni boshqarish",
      description: `Change the state of one of the account's adverts (same actions as the "My ads" page on olx.uz):
  - activate: re-activate a finished/inactive advert (may require a paid packet if the free limit is used up)
  - deactivate: hide an active advert (e.g. item sold)
  - refresh: bump the advert to the top ("Поднять"). May be PAID unless free refresh is available — confirm with the user first
  - extend: extend the validity period
  - finish: move to finished/archive
  - remove: delete a finished advert PERMANENTLY — cannot be undone; always confirm with the user first`,
      inputSchema: {
        advert_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
        action: z.enum(["activate", "deactivate", "refresh", "extend", "finish", "remove"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ advert_id, action }) => {
      const data = await graphql<{
        myAds: { updateAd: { adId: number; status: string; message?: string | null; activateResult?: { status: string; code?: string } | null } };
      }>("UpdateAd", UPDATE_AD_MUTATION, { adId: Number(advert_id), action: action.toUpperCase() });
      const r = data.myAds.updateAd;
      const failed = /error|fail/i.test(r.status) || (r.activateResult && /error|fail/i.test(r.activateResult.status));
      const text =
        `Amal: ${action} → e'lon ${r.adId ?? advert_id}\nNatija: ${r.status}${r.message ? ` — ${r.message}` : ""}` +
        (r.activateResult ? `\nFaollashtirish: ${r.activateResult.status}${r.activateResult.code ? ` (${r.activateResult.code})` : ""}` : "");
      return failed ? { isError: true, content: [{ type: "text", text }] } : textResult(text);
    }),
  );
}
