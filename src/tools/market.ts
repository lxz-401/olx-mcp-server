import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { publicGet } from "../services/publicApi.js";
import { getMyAd } from "./myads.js";
import {
  aggregateSellers,
  buildSearchQuery,
  collectOffers,
  countBy,
  countOffers,
  describeFilters,
  fetchFacets,
  normalizeOffer,
  percentileRank,
  priceStats,
  queryFromTitle,
  searchFilterShape,
  searchOffers,
  sortSchema,
  type FacetField,
  type PriceStats,
  type SearchFilters,
  type SellerAggregate,
} from "../services/market.js";
import { daysSince, formatted, money, percent, responseFormatSchema, safe, shortDate } from "../services/format.js";
import { extractPhones, fetchOfferPhones, formatPhone } from "../services/phones.js";
import { describeError } from "../errors.js";
import type { FacetItem, OfferSummary, RawOffer } from "../types.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const sampleSizeSchema = z
  .number()
  .int()
  .min(20)
  .max(500)
  .default(200)
  .describe("Tahlil uchun nechta e'lon yig'ilsin (20–500; ko'p = aniqroq, lekin sekinroq)");

interface PublicUser {
  id: number;
  name: string;
  created?: string;
  last_login?: string;
  last_seen?: string;
  is_business?: boolean;
  is_online?: boolean;
  user_ads_url?: string;
  message_response_time?: { text?: string | null };
}

interface OfferContact {
  contact_name: string | null;
  /** false — sotuvchi raqamini yashirgan (faqat chat orqali). */
  phone_available: boolean;
  /** "Показать телефон" orqali olingan raqamlar; null — so'ralmagan yoki xato. */
  phones: string[] | null;
  phones_error?: string;
  /** Tavsif yoki sarlavhaga yozib qo'yilgan raqamlar. */
  phones_in_text: string[];
}

function cleanDescription(raw: RawOffer): string {
  return (raw.description ?? "").replace(/<br\s*\/?>/gi, "").trim();
}

async function getOfferContact(raw: RawOffer, reveal: boolean): Promise<OfferContact> {
  const available = raw.contact?.phone !== false;
  const contact: OfferContact = {
    contact_name: raw.contact?.name ?? null,
    phone_available: available,
    phones: null,
    phones_in_text: extractPhones(raw.title, cleanDescription(raw)),
  };
  if (reveal && available) {
    try {
      contact.phones = await fetchOfferPhones(raw.id);
    } catch (error) {
      contact.phones_error = describeError(error);
    }
  } else if (reveal) {
    contact.phones = [];
  }
  return contact;
}

function contactLines(c: OfferContact): string[] {
  const phones =
    c.phones_error ??
    (c.phones === null
      ? "ko'rsatilmadi (include_phones=true yoki olx_get_offer_phones)"
      : c.phones.length
        ? c.phones.map(formatPhone).join(", ")
        : c.phone_available
          ? "raqam topilmadi"
          : "sotuvchi raqamini yashirgan — faqat OLX chat orqali");
  return [
    `- Aloqa: ${c.contact_name ?? "—"} · 📞 ${phones}`,
    ...(c.phones_in_text.length ? [`- Tavsifda yozilgan raqamlar: ${c.phones_in_text.map(formatPhone).join(", ")}`] : []),
  ];
}

async function getPublicUser(userId: number): Promise<PublicUser> {
  return (await publicGet<{ data: PublicUser }>(`/users/${userId}/`)).data;
}

// ---------- Markdown yordamchilari ----------

function offerLine(o: OfferSummary): string {
  const flags = [
    o.promoted ? "⭐reklama" : null,
    o.business ? "biznes" : null,
    o.condition,
    o.delivery ? "yetkazish" : null,
  ].filter(Boolean);
  return (
    `- **${o.title}** — ${o.price_label ?? money(o.price, o.currency)}${o.negotiable ? " (kelishiladi)" : ""}\n` +
    `  ${o.city ?? "—"} · ${o.seller_name ?? "—"} (seller_id ${o.seller_id ?? "—"}) · ${shortDate(o.created)} · ${o.photos} rasm` +
    `${flags.length ? " · " + flags.join(", ") : ""}\n  ${o.url} (id ${o.id})`
  );
}

function priceStatsLines(stats: PriceStats[]): string[] {
  return stats.map(
    (s) =>
      `- **${s.currency}** (${s.count} e'lon${s.outliers_removed ? `, ${s.outliers_removed} g'ayritabiiy narx chiqarildi` : ""}): ` +
      `min ${money(s.min, s.currency)} · 25% ${money(s.p25, s.currency)} · **median ${money(s.median, s.currency)}** · ` +
      `75% ${money(s.p75, s.currency)} · max ${money(s.max, s.currency)} · o'rtacha ${money(s.mean, s.currency)}`,
  );
}

/** total berilmasa foiz ko'rsatilmaydi (kategoriyalar ierarxik — ularning ulushlari yig'indisi 100% dan oshadi). */
function facetLines(items: FacetItem[] | undefined, total: number | null, top = 8): string {
  if (!items?.length) return "—";
  return items
    .slice(0, top)
    .map((f) => `${f.label} ${f.count}${total ? ` (${percent(f.count, total)})` : ""}`)
    .join(" · ");
}

function sellerLines(sellers: SellerAggregate[], top: number): string[] {
  return sellers.slice(0, top).map(
    (s, i) =>
      `${i + 1}. **${s.name ?? "—"}** (seller_id ${s.seller_id})${s.business ? " · biznes" : ""} — ` +
      `${s.listings_in_sample} e'lon, ${s.promoted_listings} reklamada, median ${money(s.median_price, s.currency)}, ` +
      `${s.cities.slice(0, 3).join("/") || "—"}, OLX'da ${shortDate(s.seller_since)} dan`,
  );
}

// ---------- Tahlil ----------

interface MarketReport {
  filters: SearchFilters;
  total_listings: number;
  sample_size: number;
  price_stats: PriceStats[];
  owner_split: FacetItem[];
  top_regions: FacetItem[];
  top_cities: FacetItem[];
  top_categories: FacetItem[];
  condition_split: { key: string; count: number }[];
  promoted_share: number;
  delivery_share: number;
  median_listing_age_days: number | null;
  refreshed_last_7_days_share: number;
  median_photos: number;
  top_sellers: SellerAggregate[];
  recommendations: string[];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function facetFieldsFor(filters: SearchFilters): FacetField[] {
  const fields: FacetField[] = ["owner_type"];
  const hasLocation = filters.city_id || filters.district_id;
  if (!filters.region_id && !hasLocation) fields.push("region");
  if (!hasLocation) fields.push("city");
  if (!filters.category_id) fields.push("category");
  return fields;
}

async function buildMarketReport(filters: SearchFilters, sampleSize: number): Promise<{ report: MarketReport; offers: OfferSummary[] }> {
  const query = buildSearchQuery(filters);
  const [{ total, facets }, { offers }] = await Promise.all([
    // O'zining filtri qo'yilgan o'lchov bo'yicha facet so'ralmaydi: OLX bunday holatda filtrsiz ("agar tanlansa") sonlarni qaytaradi.
    fetchFacets(query, facetFieldsFor(filters), 10),
    collectOffers(query, sampleSize),
  ]);
  const stats = priceStats(offers);
  const ages = offers.map((o) => daysSince(o.created)).filter((d): d is number => d !== null);
  const refreshedRecently = offers.filter((o) => (daysSince(o.refreshed ?? o.created) ?? 99) <= 7).length;
  const sellers = aggregateSellers(offers);
  const promotedShare = offers.length ? offers.filter((o) => o.promoted).length / offers.length : 0;
  const businessCount = facets.owner_type?.find((f) => f.id === "business")?.count ?? 0;

  const recommendations: string[] = [];
  const main = stats[0];
  if (main) {
    recommendations.push(
      `Raqobatbardosh narx oralig'i: ${money(main.p25, main.currency)} – ${money(main.median, main.currency)} ` +
        `(median'dan past narx tezroq sotadi, 75% dan yuqorisi — ${money(main.p75, main.currency)} — qimmat ko'rinadi).`,
    );
  }
  if (total > 500) recommendations.push(`Raqobat yuqori (${total} ta e'lon) — sarlavhada model/xotira/rang kabi aniq belgilarni yozing.`);
  if (promotedShare > 0.2)
    recommendations.push(`Namunadagi e'lonlarning ${Math.round(promotedShare * 100)}% reklamada — ko'rinish uchun TOP/VIP xizmati kerak bo'lishi mumkin.`);
  if (total && businessCount / total > 0.4)
    recommendations.push(`Bozorning ${percent(businessCount, total)} qismi biznes sotuvchilar — kafolat, yetkazib berish, chek kabi ustunliklarni ko'rsating.`);
  const medianPhotos = median(offers.map((o) => o.photos)) ?? 0;
  recommendations.push(`Raqobatchilarda o'rtacha ${medianPhotos} ta rasm — kamida ${Math.max(medianPhotos + 1, 5)} ta sifatli rasm qo'ying.`);

  return {
    offers,
    report: {
      filters,
      total_listings: total,
      sample_size: offers.length,
      price_stats: stats,
      owner_split: facets.owner_type ?? [],
      top_regions: facets.region ?? [],
      top_cities: facets.city ?? [],
      top_categories: facets.category ?? [],
      condition_split: countBy(offers, (o) => o.condition),
      promoted_share: promotedShare,
      delivery_share: offers.length ? offers.filter((o) => o.delivery).length / offers.length : 0,
      median_listing_age_days: ages.length ? Math.round(median(ages) ?? 0) : null,
      refreshed_last_7_days_share: offers.length ? refreshedRecently / offers.length : 0,
      median_photos: medianPhotos,
      top_sellers: sellers.slice(0, 10),
      recommendations,
    },
  };
}

function marketMarkdown(r: MarketReport): string {
  return [
    `# Bozor tahlili: ${describeFilters(r.filters)}`,
    `Jami faol e'lonlar: **${r.total_listings}** · tahlil qilingan namuna: ${r.sample_size}`,
    "",
    "## Narxlar",
    ...(r.price_stats.length ? priceStatsLines(r.price_stats) : ["- Narx ma'lumoti yo'q"]),
    "",
    "## Bozor tuzilmasi",
    `- Sotuvchilar: ${facetLines(r.owner_split, r.total_listings)}`,
    ...(r.top_regions.length ? [`- Viloyatlar: ${facetLines(r.top_regions, r.total_listings)}`] : []),
    ...(r.top_cities.length ? [`- Shaharlar: ${facetLines(r.top_cities, r.total_listings)}`] : []),
    ...(r.top_categories.length ? [`- Kategoriyalar: ${facetLines(r.top_categories, null, 5)}`] : []),
    `- Holati (namuna): ${r.condition_split.map((c) => `${c.key} ${percent(c.count, r.sample_size)}`).join(" · ") || "—"}`,
    `- Reklamadagi e'lonlar: ${Math.round(r.promoted_share * 100)}% · yetkazib berish: ${Math.round(r.delivery_share * 100)}%`,
    `- E'lonlar yoshi (median): ${r.median_listing_age_days ?? "—"} kun · so'nggi 7 kunda yangilangan: ${Math.round(r.refreshed_last_7_days_share * 100)}%`,
    `- Rasm soni (median): ${r.median_photos}`,
    "",
    "## Eng faol raqobatchilar (namunada)",
    ...(r.top_sellers.length ? sellerLines(r.top_sellers, 10) : ["—"]),
    "",
    "## Tavsiyalar",
    ...r.recommendations.map((x) => `- ${x}`),
  ].join("\n");
}

export function registerMarketTools(server: McpServer): void {
  server.registerTool(
    "olx_search_offers",
    {
      title: "OLX'da e'lonlarni qidirish",
      description: `Search live OLX listings (public site data, no auth needed) with filters and sorting.
Use to look at competitor listings for a product, check current prices, or browse a category/region.

Args: query, category_id, region_id, city_id, district_id, price_from, price_to (UZS), owner_type (private|business),
condition (new|used), sort (relevance|newest|price_asc|price_desc), offset, limit (1–50), response_format.

Returns: total matching listings and offers with id, title, price, currency, condition, seller (id, name, business),
city/region, created date, promotion flags, photo count, URL; plus has_more/next_offset for pagination (max offset 1000).
For aggregated stats use olx_analyze_market instead of paging manually.`,
      inputSchema: {
        ...searchFilterShape,
        sort: sortSchema,
        offset: z.number().int().min(0).max(950).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        response_format: responseFormatSchema,
      },
      annotations: readOnly,
    },
    safe(async ({ sort, offset, limit, response_format, ...filters }) => {
      const query = buildSearchQuery(filters, sort);
      const [page, total] = await Promise.all([searchOffers(query, offset, limit), countOffers(query).catch(() => null)]);
      if (total !== null) page.total = total;
      return formatted(response_format, page, () =>
        page.offers.length
          ? [
              `# Qidiruv: ${describeFilters(filters)} — ${page.total} ta e'lon`,
              "",
              ...page.offers.map(offerLine),
              "",
              page.has_more ? `Keyingi sahifa: offset=${page.next_offset}` : "Boshqa natija yo'q.",
            ].join("\n")
          : `Hech narsa topilmadi (${describeFilters(filters)}). So'rovni qisqartiring yoki filtrlarni olib tashlang.`,
      );
    }),
  );

  server.registerTool(
    "olx_get_offer",
    {
      title: "Raqobatchi e'lonini ko'rish",
      description: `Get full public details of any OLX listing by its numeric id (from search results): description, all parameters,
price, seller, location, promotion flags, dates, contact name and phone numbers written in the description.
Set include_phones=true to also reveal the seller's contact phone (same as the "Show phone" button).
Useful to study how a competitor writes and positions their listing.`,
      inputSchema: {
        offer_id: z.number().int().positive(),
        include_phones: z
          .boolean()
          .default(false)
          .describe("Sotuvchining telefon raqamini ham ochish (\"Показать телефон\"; sotuvchining statistikasiga yoziladi)"),
        response_format: responseFormatSchema,
      },
      annotations: readOnly,
    },
    safe(async ({ offer_id, include_phones, response_format }) => {
      const raw = (await publicGet<{ data: RawOffer }>(`/offers/${offer_id}/`)).data;
      const offer = normalizeOffer(raw);
      const params = (raw.params ?? []).map((p) => ({ name: p.name, value: p.value.label ?? String(p.value.value ?? "") }));
      const description = cleanDescription(raw);
      const contact = await getOfferContact(raw, include_phones);
      return formatted(response_format, { ...offer, params, description, contact }, () =>
        [
          `# ${offer.title}`,
          offerLine(offer),
          `- Yangilangan: ${shortDate(offer.refreshed)} · Holati: ${raw.status ?? "—"}`,
          ...contactLines(contact),
          "",
          "## Parametrlar",
          ...params.map((p) => `- ${p.name}: ${p.value}`),
          "",
          "## Tavsif",
          description || "—",
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "olx_get_offer_phones",
    {
      title: "E'lonlardagi aloqa raqamlari",
      description: `Reveal the contact phone numbers of one or more OLX listings (the same as pressing "Показать телефон" on the site).
No login needed. For each offer returns: title, url, seller, contact name, phones from the "show phone" button,
and phone numbers the seller wrote in the title/description. If the seller hid the phone, phones is [] and phone_available=false.

Notes: each reveal is counted in the seller's statistics and OLX applies a daily limit (429) — request only the
offers the user actually needs. Offer ids come from olx_search_offers / olx_get_seller.`,
      inputSchema: {
        offer_ids: z.array(z.number().int().positive()).min(1).max(20).describe("E'lon ID lari (1–20 ta)"),
        response_format: responseFormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ offer_ids, response_format }) => {
      type PhoneResult =
        | ({ id: number; title: string; url: string; seller_id: number | null; seller_name: string | null; price_label: string } & OfferContact)
        | { id: number; error: string };
      const results: PhoneResult[] = [];
      // Ketma-ket: OLX bir vaqtdagi ko'p "telefonni ko'rsatish" so'rovlarini shubhali deb bloklaydi.
      for (const id of [...new Set(offer_ids)]) {
        try {
          const raw = (await publicGet<{ data: RawOffer }>(`/offers/${id}/`)).data;
          const offer = normalizeOffer(raw);
          results.push({
            id,
            title: offer.title,
            url: offer.url,
            seller_id: offer.seller_id,
            seller_name: offer.seller_name,
            price_label: offer.price_label ?? money(offer.price, offer.currency),
            ...(await getOfferContact(raw, true)),
          });
        } catch (error) {
          results.push({ id, error: describeError(error) });
        }
      }
      return formatted(response_format, { offers: results }, () =>
        [
          `# Aloqa raqamlari (${results.length} ta e'lon)`,
          "",
          ...results.map((r) =>
            "error" in r
              ? `## ID ${r.id}\n${r.error}\n`
              : [
                  `## ${r.title} — ${r.price_label}`,
                  `- Sotuvchi: ${r.seller_name ?? "—"} (seller_id ${r.seller_id ?? "—"})`,
                  ...contactLines(r),
                  `- ${r.url} (id ${r.id})`,
                  "",
                ].join("\n"),
          ),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "olx_get_seller",
    {
      title: "Sotuvchi (raqobatchi) profili",
      description: `Analyze any OLX seller by user id (seller_id from search results): public profile (name, business flag,
registration date, last activity, response time), total active listings, their categories and price levels,
share of promoted listings, and a sample of their latest listings.`,
      inputSchema: {
        seller_id: z.number().int().positive(),
        listings_sample: z.number().int().min(0).max(100).default(20).describe("Nechta e'lonini ko'rsatish/tahlil qilish"),
        response_format: responseFormatSchema,
      },
      annotations: readOnly,
    },
    safe(async ({ seller_id, listings_sample, response_format }) => {
      const query = buildSearchQuery({ user_id: seller_id }, "newest");
      const [user, { total, facets }, sample] = await Promise.all([
        getPublicUser(seller_id),
        fetchFacets(query, ["category", "city"], 8),
        listings_sample ? collectOffers(query, listings_sample) : Promise.resolve({ offers: [] as OfferSummary[], total: 0 }),
      ]);
      const offers = sample.offers;
      const data = {
        user,
        total_active_listings: total,
        categories: facets.category ?? [],
        cities: facets.city ?? [],
        price_stats: priceStats(offers, false),
        promoted_share: offers.length ? offers.filter((o) => o.promoted).length / offers.length : 0,
        listings: offers,
      };
      return formatted(response_format, data, () =>
        [
          `# Sotuvchi: ${user.name} (ID ${user.id})${user.is_business ? " · Biznes" : ""}`,
          `- OLX'da: ${shortDate(user.created)} dan · oxirgi faollik: ${shortDate(user.last_seen ?? user.last_login)}${user.is_online ? " (hozir onlayn)" : ""}`,
          `- Javob berish vaqti: ${user.message_response_time?.text ?? "—"}`,
          `- Faol e'lonlar: **${total}** · barcha e'lonlari: ${user.user_ads_url ?? "—"}`,
          `- Kategoriyalar: ${facetLines(data.categories, null, 6)}`,
          `- Shaharlar: ${facetLines(data.cities, total, 5)}`,
          `- Reklamadagi e'lonlar (namunada): ${Math.round(data.promoted_share * 100)}%`,
          ...(data.price_stats.length ? ["", "## Narxlar (namuna)", ...priceStatsLines(data.price_stats)] : []),
          ...(offers.length ? ["", "## So'nggi e'lonlari", ...offers.map(offerLine)] : []),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "olx_analyze_market",
    {
      title: "Bozor va narx tahlili",
      description: `Analyze the OLX market for a product/segment. Collects up to sample_size live listings plus site-wide facet counts and returns:
- total active listings (competition level)
- price statistics per currency (min / 25% / median / 75% / max / mean, outliers removed)
- private vs business split, top regions, cities and categories
- condition split, share of promoted (paid) listings, delivery share
- listing age and refresh activity, typical photo count
- most active sellers in the sample
- actionable recommendations (competitive price range, photos, promotion)

Use for "how much should I sell X for", "how competitive is this niche", "who dominates this market". No auth needed.
Tip: narrow with category_id to exclude accessories (e.g. 'iphone 13' also matches cases).`,
      inputSchema: {
        ...searchFilterShape,
        sample_size: sampleSizeSchema,
        response_format: responseFormatSchema,
      },
      annotations: readOnly,
    },
    safe(async ({ sample_size, response_format, ...filters }) => {
      const { report } = await buildMarketReport(filters, sample_size);
      if (!report.total_listings && !report.sample_size) {
        return { content: [{ type: "text", text: `E'lonlar topilmadi (${describeFilters(filters)}). So'rovni kengaytiring.` }] };
      }
      return formatted(response_format, report, () => marketMarkdown(report));
    }),
  );

  server.registerTool(
    "olx_find_competitors",
    {
      title: "Raqobatchilarni aniqlash",
      description: `Identify the main competitors (sellers) for a product/segment on OLX. Groups sampled listings by seller and ranks them
by number of listings, then enriches the top sellers with their public profile and total active listing count.

Returns per competitor: seller_id, name, business flag, listings in this segment, promoted listings, median price,
cities, account age, last activity, total active listings on OLX, sample URLs.
Follow up with olx_get_seller(seller_id) for a deep dive on one competitor. No auth needed.`,
      inputSchema: {
        ...searchFilterShape,
        sample_size: sampleSizeSchema,
        top: z.number().int().min(1).max(20).default(10).describe("Nechta raqobatchini batafsil ko'rsatish"),
        response_format: responseFormatSchema,
      },
      annotations: readOnly,
    },
    safe(async ({ sample_size, top, response_format, ...filters }) => {
      const query = buildSearchQuery(filters);
      const [{ offers }, total] = await Promise.all([collectOffers(query, sample_size), countOffers(query)]);
      if (!offers.length) {
        return { content: [{ type: "text", text: `E'lonlar topilmadi (${describeFilters(filters)}).` }] };
      }
      const sellers = aggregateSellers(offers).slice(0, top);
      const enriched = await Promise.all(
        sellers.map(async (s) => {
          const [profile, totalListings] = await Promise.all([
            getPublicUser(s.seller_id).catch(() => null),
            countOffers(buildSearchQuery({ user_id: s.seller_id })).catch(() => null),
          ]);
          return {
            ...s,
            total_active_listings: totalListings,
            last_seen: profile?.last_seen ?? null,
            response_time: profile?.message_response_time?.text ?? null,
            profile_url: profile?.user_ads_url ?? null,
          };
        }),
      );
      const uniqueSellers = new Set(offers.map((o) => o.seller_id)).size;
      const topShare = enriched.reduce((sum, s) => sum + s.listings_in_sample, 0) / offers.length;
      const data = { filters, total_listings: total, sample_size: offers.length, unique_sellers: uniqueSellers, top_sellers_share: topShare, competitors: enriched };

      return formatted(response_format, data, () =>
        [
          `# Raqobatchilar: ${describeFilters(filters)}`,
          `Jami e'lonlar: ${total} · namuna: ${offers.length} · noyob sotuvchilar: ${uniqueSellers} · ` +
            `TOP-${enriched.length} ulushi: ${Math.round(topShare * 100)}%` +
            (topShare > 0.5 ? " (bozor bir necha yirik sotuvchi qo'lida)" : " (bozor tarqoq)"),
          "",
          ...enriched.map(
            (s, i) =>
              `${i + 1}. **${s.name ?? "—"}** (seller_id ${s.seller_id})${s.business ? " · biznes" : ""}\n` +
              `   segmentda ${s.listings_in_sample} e'lon (${s.promoted_listings} reklamada) · median ${money(s.median_price, s.currency)} · ` +
              `OLX'da jami ${s.total_active_listings ?? "?"} e'lon\n` +
              `   ${s.cities.slice(0, 3).join("/") || "—"} · OLX'da ${shortDate(s.seller_since)} dan · oxirgi faollik ${shortDate(s.last_seen)}` +
              `${s.response_time ? ` · javob: ${s.response_time}` : ""}\n` +
              `   ${s.profile_url ?? s.sample_urls[0] ?? ""}`,
          ),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "olx_compare_my_advert",
    {
      title: "Mening e'lonimni raqobatchilar bilan solishtirish",
      description: `Compare one of the logged-in account's adverts against similar live listings on OLX.
Loads the advert and its stats (needs a session), searches similar offers (by title keywords within the same
category), and reports: price percentile and rank vs competitors, market price stats, photo count vs competitors,
promoted share, phone-view conversion, and concrete recommendations (price change, photos, promotion, title).

Args:
  - advert_id: your advert id (from olx_list_my_adverts)
  - query: override search keywords (default: first 5 words of your title)
  - city_id / region_id: restrict competitors to a location (olx_find_location)
  - sample_size: listings to compare against`,
      inputSchema: {
        advert_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
        query: z.string().min(2).optional().describe("Qidiruv so'zlarini qo'lda berish"),
        city_id: searchFilterShape.city_id,
        region_id: searchFilterShape.region_id,
        sample_size: sampleSizeSchema,
        response_format: responseFormatSchema,
      },
      annotations: readOnly,
    },
    safe(async ({ advert_id, query, city_id, region_id, sample_size, response_format }) => {
      const advert = await getMyAd(advert_id);
      if (!advert) return { isError: true, content: [{ type: "text", text: `E'lon ${advert_id} topilmadi yoki sizga tegishli emas.` }] };
      const stats = advert.stats ?? null;
      const filters: SearchFilters = {
        query: query ?? queryFromTitle(advert.title),
        category_id: advert.categoryId,
        city_id,
        region_id,
      };
      const { report, offers } = await buildMarketReport(filters, sample_size);
      const competitors = offers.filter((o) => String(o.id) !== String(advert.id));
      const myPrice = advert.price ?? undefined;
      const myCurrency = advert.currency ?? "UZS";
      const market = report.price_stats.find((s) => s.currency === myCurrency);
      const rank = myPrice !== undefined ? percentileRank(myPrice, myCurrency, competitors) : null;
      const myPhotos = advert.photos?.length ?? 0;
      const views = stats?.views ?? 0;
      const phones = stats?.phones ?? 0;
      const conversion = views ? phones / views : null;
      const cheaper = competitors
        .filter((o) => o.currency === myCurrency && o.price !== null && myPrice !== undefined && o.price < myPrice)
        .sort((a, b) => (b.price ?? 0) - (a.price ?? 0))
        .slice(0, 5);

      const recs: string[] = [];
      if (market && myPrice !== undefined) {
        if (myPrice > market.p75)
          recs.push(`Narxingiz bozorning 75% idan yuqori. Tezroq sotish uchun ${money(market.median, myCurrency)} atrofiga tushiring.`);
        else if (myPrice > market.median)
          recs.push(`Narx median'dan biroz yuqori — sifat ustunliklarini (holat, kafolat, komplekt) tavsifda aniq yozing yoki ${money(market.median, myCurrency)} gacha tushiring.`);
        else if (myPrice < market.p25)
          recs.push(`Narxingiz eng arzonlar qatorida (25% dan past). Ehtimol ${money(market.p25, myCurrency)} gacha oshirsangiz ham tez sotiladi.`);
        else recs.push("Narx raqobatbardosh oraliqda (25%–median).");
      } else if (myPrice === undefined) {
        recs.push("E'londa narx ko'rsatilmagan — narxli e'lonlar ko'proq qo'ng'iroq oladi.");
      }
      if (myPhotos < report.median_photos) recs.push(`Rasmlar kam: sizda ${myPhotos}, raqobatchilarda median ${report.median_photos}. Ko'proq rasm qo'ying.`);
      if (report.promoted_share > 0.2) recs.push(`Raqobatchilarning ${Math.round(report.promoted_share * 100)}% reklamada — TOP xizmati ko'rinishni oshiradi.`);
      if (conversion !== null && views >= 30 && conversion < 0.03)
        recs.push(`Ko'rishlardan telefon ko'rishga o'tish past (${percent(phones, views)}): narx, birinchi rasm va sarlavhani yaxshilang.`);
      if (advert.status !== "ACTIVE") recs.push(`E'lon holati '${advert.status}' — u saytda ko'rinmayapti.`);

      const data = {
        advert: { id: advert.id, title: advert.title, status: advert.status, price: advert.price, currency: myCurrency, photos: myPhotos },
        statistics: stats,
        phone_view_conversion: conversion,
        search_filters: filters,
        competitors_found: report.total_listings,
        market_price: market ?? null,
        my_price_percentile: rank,
        cheaper_competitors: cheaper,
        market: report,
        recommendations: recs,
      };

      return formatted(response_format, data, () =>
        [
          `# Solishtirish: ${advert.title} (ID ${advert.id})`,
          `- Holati: ${advert.status} · narx: ${money(myPrice, myCurrency)} · rasmlar: ${myPhotos}`,
          stats ? `- Statistika: 👁 ${views} · 📞 ${phones} (${percent(phones, views)}) · ⭐ ${stats.observed ?? 0}` : "- Statistika: —",
          `- Qidiruv: ${describeFilters(filters)} → ${report.total_listings} ta o'xshash e'lon`,
          "",
          "## Narx pozitsiyasi",
          market
            ? `- Bozor (${myCurrency}): 25% ${money(market.p25, myCurrency)} · median ${money(market.median, myCurrency)} · 75% ${money(market.p75, myCurrency)}`
            : `- ${myCurrency} valyutasida taqqoslash uchun narxlar yetarli emas.`,
          ...(rank !== null ? [`- Raqobatchilarning **${rank}%** i sizdan arzon.`] : []),
          ...(cheaper.length ? ["", "## Sizdan arzonroq eng yaqin raqobatchilar", ...cheaper.map(offerLine)] : []),
          "",
          "## Asosiy raqobatchilar",
          ...(report.top_sellers.length ? sellerLines(report.top_sellers, 5) : ["—"]),
          "",
          "## Tavsiyalar",
          ...recs.map((x) => `- ${x}`),
        ].join("\n"),
      );
    }),
  );
}
