import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessionRest } from "../services/session.js";
import { publicGet } from "../services/publicApi.js";
import { formatted, responseFormatSchema, safe, textResult } from "../services/format.js";
import { CATEGORIES_URL, GRAPHQL_URL, LANG, OLX_SITE_CODE, REQUEST_TIMEOUT_MS } from "../constants.js";
import { OlxApiError } from "../errors.js";

interface CategorySuggestion {
  id: string;
  name: string;
  path?: { id: string; name: string }[];
}

interface CategoryParameter {
  id: number;
  code: string;
  label: string;
  type: string;
  range: boolean;
  validation?: { min?: number | null; max?: number | null; is_required?: boolean };
  units?: { code: string; label: string }[] | null;
  values?: { key: string; label: string }[];
}

export interface PostingCategory {
  id: number;
  parent: number;
  label: string;
  path: string;
  is_addable: boolean;
  is_business: boolean;
  max_photos: number;
  extend_days: number;
  children: number[];
  parameters: CategoryParameter[];
}

interface GeoSuggestion {
  city?: { id: number; name: string; lat?: number; lon?: number };
  region?: { id: number; name: string };
  district?: { id: number; name: string; lat?: number; lon?: number };
}

interface CategoryNode {
  id: number;
  name: string;
  parent_id: number;
}

let categoryTree: Promise<CategoryNode[]> | undefined;

/** Butun kategoriya daraxti (anonim GraphQL, jarayon davomida keshlanadi). */
async function getCategoryTree(): Promise<CategoryNode[]> {
  categoryTree ??= fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", site: OLX_SITE_CODE, "x-client": "DESKTOP", "accept-language": LANG },
    body: JSON.stringify({ query: "query Categories { categories { id name parent_id } }" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .then((r) => r.json() as Promise<{ data?: { categories?: CategoryNode[] } }>)
    .then((j) => {
      if (!j.data?.categories?.length) throw new OlxApiError("Kategoriyalar ro'yxatini olib bo'lmadi.", 502);
      return j.data.categories;
    });
  categoryTree.catch(() => {
    categoryTree = undefined;
  });
  return categoryTree;
}

function categoryPath(tree: CategoryNode[], id: number): string {
  const byId = new Map(tree.map((c) => [c.id, c]));
  const names: string[] = [];
  for (let node = byId.get(id); node; node = byId.get(node.parent_id)) names.unshift(node.name);
  return names.join(" › ");
}

/** Kategoriya ma'lumoti va e'lon parametrlari (ochiq CDN, avtorizatsiyasiz). */
export async function getPostingCategory(categoryId: number): Promise<PostingCategory> {
  const response = await fetch(`${CATEGORIES_URL}/${categoryId}?brand=${OLX_SITE_CODE}&lang=${LANG}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new OlxApiError(`Kategoriya ${categoryId} topilmadi.`, response.status);
  return (await response.json()) as PostingCategory;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerReferenceTools(server: McpServer): void {
  server.registerTool(
    "olx_suggest_category",
    {
      title: "Sarlavha bo'yicha kategoriya tavsiyasi",
      description: `Suggest OLX categories for an advert title (the same suggestion the olx.uz posting form shows). Needs a logged-in session.
Returns category ids with full path. Then call olx_get_category(id) to see required parameters.`,
      inputSchema: { title: z.string().min(3).describe("E'lon sarlavhasi, masalan 'iPhone 13 128GB qora'") },
      annotations: readOnly,
    },
    safe(async ({ title }) => {
      const { data } = await sessionRest<{ data: CategorySuggestion[] }>("GET", `/categories/suggestion/?q=${encodeURIComponent(title)}`);
      if (!data?.length) return textResult("Tavsiya topilmadi. Sarlavhani aniqroq yozing yoki olx_get_category bilan qo'lda tanlang.");
      return textResult(
        "Tavsiya etilgan kategoriyalar:\n" +
          data.map((c) => `- **${c.id}** — ${[...(c.path ?? []).map((p) => p.name), c.name].join(" › ")}`).join("\n"),
      );
    }),
  );

  server.registerTool(
    "olx_list_categories",
    {
      title: "OLX kategoriyalari",
      description: `Browse or search the OLX category tree (no auth). Without arguments returns top-level categories;
parent_id lists subcategories; search finds categories by name (Russian/Uzbek as shown on the site) and shows full paths.
Use the ids as category_id in market tools and olx_get_category.`,
      inputSchema: {
        parent_id: z.number().int().min(0).optional().describe("Ota-kategoriya ID (0 = eng yuqori daraja)"),
        search: z.string().min(2).optional().describe("Nom bo'yicha qidiruv, masalan 'телефон'"),
      },
      annotations: readOnly,
    },
    safe(async ({ parent_id, search }) => {
      const tree = await getCategoryTree();
      const childCount = new Map<number, number>();
      for (const c of tree) childCount.set(c.parent_id, (childCount.get(c.parent_id) ?? 0) + 1);
      const list = search
        ? tree.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())).slice(0, 40)
        : tree.filter((c) => c.parent_id === (parent_id ?? 0));
      if (!list.length) return textResult("Kategoriya topilmadi.");
      return textResult(
        list
          .map((c) => `- **${c.id}** ${search ? categoryPath(tree, c.id) : c.name}${childCount.get(c.id) ? ` (${childCount.get(c.id)} ta subkategoriya)` : ""}`)
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "olx_get_category",
    {
      title: "Kategoriya va uning parametrlari",
      description: `Get an OLX category: name, path, whether adverts can be posted in it (is_addable / leaf), max photos, validity days,
subcategories, and the advert PARAMETERS — code, label, type (enum/price/input...), required flag, units (e.g. currency UZS/UYE)
and allowed values (key=label). Use the parameter codes and value keys when posting an advert. No auth needed. Find category ids with olx_list_categories.`,
      inputSchema: {
        category_id: z.number().int().positive(),
        include_children: z.boolean().default(true).describe("Subkategoriyalar nomlarini ham olish"),
        response_format: responseFormatSchema,
      },
      annotations: readOnly,
    },
    safe(async ({ category_id, include_children, response_format }) => {
      const category = await getPostingCategory(category_id);
      const children =
        include_children && category.children.length
          ? await Promise.all(
              category.children.slice(0, 60).map((id) =>
                getPostingCategory(id)
                  .then((c) => ({ id, label: c.label, is_leaf: c.children.length === 0 }))
                  .catch(() => ({ id, label: "?", is_leaf: false })),
              ),
            )
          : [];
      return formatted(response_format, { ...category, children_details: children }, () => {
        const lines = [
          `# ${category.label} (ID ${category.id})`,
          `- Yo'l: ${category.path} · ota-kategoriya: ${category.parent}`,
          `- E'lon joylash mumkin: ${category.is_addable && !category.children.length ? "ha (oxirgi kategoriya)" : "yo'q — subkategoriyani tanlang"}`,
          `- Maks. rasm: ${category.max_photos} · amal qilish muddati: ${category.extend_days} kun`,
        ];
        if (children.length) {
          lines.push("", "## Subkategoriyalar", ...children.map((c) => `- **${c.id}** ${c.label}${c.is_leaf ? "" : " ›"}`));
        }
        if (category.parameters.length) {
          lines.push("", "## Parametrlar");
          for (const p of category.parameters) {
            if (p.type === "hidden") continue;
            const v = p.validation ?? {};
            const flags = [
              v.is_required ? "**majburiy**" : "ixtiyoriy",
              p.type,
              p.units?.length ? `birlik: ${p.units.map((u) => u.code).join("/")}` : null,
              v.min !== null && v.min !== undefined ? `min ${v.min}` : null,
              v.max !== null && v.max !== undefined ? `max ${v.max}` : null,
            ].filter(Boolean);
            const values =
              p.type !== "price" && p.values?.length
                ? `\n  qiymatlar: ${p.values.slice(0, 50).map((x) => `${x.key}=${x.label}`).join(", ")}${p.values.length > 50 ? ` … (+${p.values.length - 50})` : ""}`
                : "";
            lines.push(`- \`${p.code}\` — ${p.label} (${flags.join(", ")})${values}`);
          }
        }
        return lines.join("\n");
      });
    }),
  );

  server.registerTool(
    "olx_find_location",
    {
      title: "Shahar / tuman ID sini topish",
      description: `Find OLX city_id / district_id / region_id by place name (e.g. "Samarqand", "Chilonzor", "Ташкент"). No auth needed.
Use the IDs for market search filters (city_id, region_id, district_id) and for advert location.`,
      inputSchema: { name: z.string().min(2).describe("Joy nomi") },
      annotations: readOnly,
    },
    safe(async ({ name }) => {
      const res = await publicGet<{ data: GeoSuggestion[] }>("/geo-encoder/location-autocomplete/", { query: name, limit: 15, scope: "posting" });
      const items = res.data ?? [];
      if (!items.length) return textResult(`"${name}" bo'yicha joy topilmadi. Boshqa yozilishda urinib ko'ring (ruscha/lotin).`);
      return textResult(
        items
          .map(
            (i) =>
              `- ${i.city?.name ?? "—"}${i.district ? `, ${i.district.name} (district_id ${i.district.id})` : ""} — ` +
              `city_id **${i.city?.id ?? "—"}**, ${i.region?.name ?? "—"} (region_id ${i.region?.id ?? "—"})`,
          )
          .join("\n"),
      );
    }),
  );
}
