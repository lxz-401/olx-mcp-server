import { z } from "zod";
import { PUBLIC_MAX_OFFSET, PUBLIC_PAGE_SIZE } from "../constants.js";
import type { FacetItem, OfferSummary, OffersResponse, RawOffer } from "../types.js";
import { publicGet, type PublicQuery } from "./publicApi.js";
import { daysSince } from "./format.js";

// ---------- Qidiruv filtrlari (bir nechta toolda qayta ishlatiladi) ----------

export const searchFilterShape = {
  query: z.string().min(2).max(200).optional().describe("Qidiruv so'zi, masalan 'iphone 13 128gb'"),
  category_id: z.number().int().positive().optional().describe("OLX kategoriya ID (masalan 85 = Mobil telefonlar)"),
  region_id: z.number().int().positive().optional().describe("Viloyat ID (olx_find_location orqali toping)"),
  city_id: z.number().int().positive().optional().describe("Shahar ID (olx_find_location orqali toping, masalan 4 = Toshkent)"),
  district_id: z.number().int().positive().optional().describe("Tuman ID"),
  price_from: z.number().nonnegative().optional().describe("Minimal narx (so'mda)"),
  price_to: z.number().nonnegative().optional().describe("Maksimal narx (so'mda)"),
  owner_type: z.enum(["private", "business"]).optional().describe("Faqat xususiy yoki faqat biznes sotuvchilar"),
  condition: z.enum(["new", "used"]).optional().describe("Holati: yangi yoki b/u (ko'p kategoriyalarda ishlaydi)"),
};

export const searchFiltersSchema = z.object(searchFilterShape);
export type SearchFilters = z.infer<typeof searchFiltersSchema>;

export const sortSchema = z
  .enum(["relevance", "newest", "price_asc", "price_desc"])
  .default("relevance")
  .describe("Saralash: relevance | newest | price_asc | price_desc");

const SORT_MAP: Record<string, string | undefined> = {
  relevance: undefined,
  newest: "created_at:desc",
  price_asc: "filter_float_price:asc",
  price_desc: "filter_float_price:desc",
};

export function buildSearchQuery(filters: SearchFilters & { user_id?: number }, sort?: string): PublicQuery {
  return {
    query: filters.query,
    category_id: filters.category_id,
    region_id: filters.region_id,
    city_id: filters.city_id,
    district_id: filters.district_id,
    "filter_float_price:from": filters.price_from,
    "filter_float_price:to": filters.price_to,
    owner_type: filters.owner_type,
    "filter_enum_state[0]": filters.condition,
    user_id: filters.user_id,
    sort_by: sort ? SORT_MAP[sort] : undefined,
  };
}

export function describeFilters(filters: SearchFilters): string {
  const parts = Object.entries(filters)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? parts.join(", ") : "filtrsiz";
}

// ---------- Normalizatsiya ----------

export function normalizeOffer(raw: RawOffer, promotedByPosition = false): OfferSummary {
  const priceParam = raw.params?.find((p) => p.type === "price" || p.key === "price");
  const state = raw.params?.find((p) => p.key === "state");
  const promo = raw.promotion ?? {};
  const promotion = [
    promo.top_ad ? "top" : null,
    promo.highlighted ? "highlight" : null,
    promo.urgent ? "urgent" : null,
  ].filter((x): x is string => x !== null);
  return {
    id: raw.id,
    title: raw.title,
    url: raw.url,
    price: typeof priceParam?.value.value === "number" ? priceParam.value.value : null,
    currency: priceParam?.value.currency ?? null,
    price_label: priceParam?.value.label ?? null,
    negotiable: Boolean(priceParam?.value.negotiable),
    condition: state?.value.label ?? null,
    business: raw.business,
    seller_id: raw.user?.id ?? null,
    seller_name: raw.user?.company_name || raw.user?.name || null,
    seller_since: raw.user?.created ?? null,
    city: raw.location?.city?.name ?? null,
    region: raw.location?.region?.name ?? null,
    district: raw.location?.district?.name ?? null,
    category_id: raw.category?.id ?? null,
    created: raw.created_time,
    refreshed: raw.last_refresh_time ?? null,
    promoted: promotedByPosition || promotion.length > 0,
    promotion,
    photos: raw.photos?.length ?? 0,
    delivery: Boolean(raw.delivery?.rock?.active),
  };
}

// ---------- Ma'lumot olish ----------

export interface SearchPage {
  offers: OfferSummary[];
  total: number;
  has_more: boolean;
  next_offset?: number;
}

export async function searchOffers(query: PublicQuery, offset: number, limit: number): Promise<SearchPage> {
  const response = await publicGet<OffersResponse>("/offers/", { ...query, offset, limit });
  const promotedIdx = new Set(response.metadata?.promoted ?? []);
  const offers = (response.data ?? []).map((raw, i) => normalizeOffer(raw, promotedIdx.has(i)));
  const total = response.metadata?.visible_total_count ?? response.metadata?.total_elements ?? offers.length;
  const nextOffset = offset + limit;
  const hasMore = Boolean(response.links?.next) && nextOffset < PUBLIC_MAX_OFFSET && offers.length > 0;
  return { offers, total, has_more: hasMore, ...(hasMore ? { next_offset: nextOffset } : {}) };
}

/** Bir nechta sahifani yig'adi, takrorlanuvchi (reklama) e'lonlarni olib tashlaydi. */
export async function collectOffers(query: PublicQuery, sampleSize: number): Promise<{ offers: OfferSummary[]; total: number }> {
  const byId = new Map<number, OfferSummary>();
  let total = 0;
  for (let offset = 0; offset < PUBLIC_MAX_OFFSET && byId.size < sampleSize; offset += PUBLIC_PAGE_SIZE) {
    const page = await searchOffers(query, offset, PUBLIC_PAGE_SIZE);
    total = page.total;
    for (const offer of page.offers) {
      const existing = byId.get(offer.id);
      if (!existing) byId.set(offer.id, offer);
      else if (offer.promoted) existing.promoted = true;
    }
    if (!page.has_more) break;
  }
  return { offers: [...byId.values()].slice(0, sampleSize), total };
}

export type FacetField = "category" | "region" | "city" | "owner_type";

interface SearchMetadata {
  visible_total_count?: number;
  total_count?: number;
  facets?: Partial<Record<string, FacetItem[]>> | [];
}

async function searchMetadata(query: PublicQuery, field?: string, limit = 10): Promise<SearchMetadata> {
  const facets = field ? JSON.stringify([{ field, fetchLabel: true, fetchUrl: false, limit }]) : undefined;
  return (await publicGet<{ data: SearchMetadata }>("/offers/metadata/search/", { ...query, facets })).data ?? {};
}

/** Filtrlarga mos faol e'lonlarning haqiqiy soni (qidiruv natijasidagi 1000 chegarasisiz). */
export async function countOffers(query: PublicQuery): Promise<number> {
  const data = await searchMetadata(query);
  return data.visible_total_count ?? data.total_count ?? 0;
}

/**
 * Facetlar alohida so'raladi: OLX ba'zi kombinatsiyalarda (masalan owner_type + category_id) 500 qaytaradi,
 * shuning uchun owner_type ikki filtrli hisob orqali olinadi va bitta facet xatosi butun tahlilni buzmaydi.
 */
export async function fetchFacets(
  query: PublicQuery,
  fields: FacetField[],
  limit = 10,
): Promise<{ total: number; facets: Partial<Record<FacetField, FacetItem[]>> }> {
  const facets: Partial<Record<FacetField, FacetItem[]>> = {};
  const tasks = fields.map(async (field) => {
    if (field === "owner_type") {
      if (query.owner_type) return;
      const [privateCount, businessCount] = await Promise.all([
        countOffers({ ...query, owner_type: "private" }),
        countOffers({ ...query, owner_type: "business" }),
      ]);
      facets.owner_type = [
        { id: "private", count: privateCount, label: "Xususiy" },
        { id: "business", count: businessCount, label: "Biznes" },
      ];
      return;
    }
    const data = await searchMetadata(query, field, limit);
    const items = Array.isArray(data.facets) ? undefined : data.facets?.[field];
    if (items) facets[field] = items;
  });
  const [total] = await Promise.all([countOffers(query), ...tasks.map((t) => t.catch(() => undefined))]);
  return { total, facets };
}

// ---------- Statistika ----------

export interface PriceStats {
  currency: string;
  count: number;
  outliers_removed: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** IQR usuli bilan g'ayritabiiy narxlarni (1 so'm, 999999999 va h.k.) olib tashlaydi. */
export function priceStats(offers: OfferSummary[], removeOutliers = true): PriceStats[] {
  const groups = new Map<string, number[]>();
  for (const o of offers) {
    if (o.price === null || o.price <= 0 || !o.currency) continue;
    groups.set(o.currency, [...(groups.get(o.currency) ?? []), o.price]);
  }
  const result: PriceStats[] = [];
  for (const [currency, values] of groups) {
    let sorted = [...values].sort((a, b) => a - b);
    const before = sorted.length;
    if (removeOutliers && sorted.length >= 8) {
      const q1 = quantile(sorted, 0.25);
      const q3 = quantile(sorted, 0.75);
      const iqr = q3 - q1;
      sorted = sorted.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
    }
    result.push({
      currency,
      count: sorted.length,
      outliers_removed: before - sorted.length,
      min: sorted[0],
      p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      max: sorted[sorted.length - 1],
      mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    });
  }
  return result.sort((a, b) => b.count - a.count);
}

/** `price` qiymatidan arzonroq e'lonlar ulushi (0–100). */
export function percentileRank(price: number, currency: string, offers: OfferSummary[]): number | null {
  const same = offers.filter((o) => o.currency === currency && o.price !== null && o.price > 0).map((o) => o.price as number);
  if (!same.length) return null;
  return Math.round((same.filter((v) => v < price).length / same.length) * 100);
}

export function countBy<T>(items: T[], key: (item: T) => string | null): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count);
}

export interface SellerAggregate {
  seller_id: number;
  name: string | null;
  business: boolean;
  listings_in_sample: number;
  promoted_listings: number;
  median_price: number | null;
  currency: string | null;
  cities: string[];
  seller_since: string | null;
  newest_listing_days: number | null;
  sample_urls: string[];
}

export function aggregateSellers(offers: OfferSummary[]): SellerAggregate[] {
  const bySeller = new Map<number, OfferSummary[]>();
  for (const o of offers) {
    if (o.seller_id === null) continue;
    bySeller.set(o.seller_id, [...(bySeller.get(o.seller_id) ?? []), o]);
  }
  return [...bySeller.entries()]
    .map(([sellerId, list]) => {
      const mainCurrency = countBy(list, (o) => o.currency)[0]?.key ?? null;
      const prices = list
        .filter((o) => o.currency === mainCurrency && o.price)
        .map((o) => o.price as number)
        .sort((a, b) => a - b);
      const ages = list.map((o) => daysSince(o.created)).filter((d): d is number => d !== null);
      return {
        seller_id: sellerId,
        name: list[0].seller_name,
        business: list.some((o) => o.business),
        listings_in_sample: list.length,
        promoted_listings: list.filter((o) => o.promoted).length,
        median_price: prices.length ? quantile(prices, 0.5) : null,
        currency: mainCurrency,
        cities: countBy(list, (o) => o.city).map((c) => c.key),
        seller_since: list[0].seller_since,
        newest_listing_days: ages.length ? Math.min(...ages) : null,
        sample_urls: list.slice(0, 3).map((o) => o.url),
      };
    })
    .sort((a, b) => b.listings_in_sample - a.listings_in_sample || b.promoted_listings - a.promoted_listings);
}

/** E'lon sarlavhasidan raqobatchilarni qidirish uchun qisqa so'rov yasaydi. */
export function queryFromTitle(title: string, maxWords = 5): string {
  return title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, maxWords)
    .join(" ");
}
