import { OlxApiError } from "../errors.js";
import { publicGet } from "./publicApi.js";
import { hasSessionFile, sessionRest } from "./session.js";

/**
 * E'londagi "Показать телефон" tugmasi bosilganda sayt chaqiradigan endpoint. Login shart emas.
 * Diqqat: har bir chaqiruv sotuvchining "telefon ko'rishlar" hisobini oshiradi va OLX kunlik limit qo'yadi (429).
 * `X-Client`/`X-Platform-Type` headerlari yuborilmasin — ular bilan OLX friction-token talab qilib 400 qaytaradi.
 */
export async function fetchOfferPhones(offerId: number): Promise<string[]> {
  const path = `/offers/${offerId}/limited-phones/`;
  let phones: string[];
  try {
    phones = (await publicGet<{ data?: { phones?: string[] } }>(path)).data?.phones ?? [];
  } catch (error) {
    if (!(error instanceof OlxApiError)) throw error;
    // Anonim so'rov rad etilsa — akkaunt sessiyasi orqali yana bir urinish
    if ((error.status === 400 || error.status === 403) && hasSessionFile()) {
      phones = (await sessionRest<{ data?: { phones?: string[] } }>("GET", path)).data?.phones ?? [];
    } else if (error.status === 429) {
      throw new OlxApiError("Telefon raqamlarini ko'rish bo'yicha kunlik limit tugadi. Ertaga qayta urinib ko'ring yoki OLX'ga kiring.", 429);
    } else if (error.status === 400) {
      throw new OlxApiError(
        "OLX telefonni ko'rsatishdan oldin qo'shimcha tekshiruv (friction/captcha) so'radi. Birozdan so'ng qayta urinib ko'ring yoki `olx_login` qiling.",
        400,
      );
    } else throw error;
  }
  return [...new Set(phones.map((p) => normalizeUzPhone(p, false) ?? p.trim()).filter(Boolean))];
}

/**
 * E'lon tavsifi/sarlavhasiga yozib qo'yilgan telefon raqamlarini topadi va +998XXXXXXXXX ko'rinishiga keltiradi.
 * Qo'llab-quvvatlanadi: "+998 90 123 45 67", "998901234567", "(90) 123-45-67", "90 1234567", "901234567".
 */
const CANDIDATE = /(?<!\d)\+?\(?\d(?:[\s().\-]{0,2}\d){8,40}(?!\d)/g;

/** Mobil operatorlar va viloyat shahar kodlari (9 xonali mahalliy raqam uchun). */
const UZ_CODES = new Set([
  "20", "33", "50", "55", "77", "88", "90", "91", "93", "94", "95", "97", "98", "99",
  "61", "62", "65", "66", "67", "69", "70", "71", "72", "73", "74", "75", "76", "78", "79",
]);

/** strict=false — OLX API'dan kelgan (aniq telefon ekani ma'lum) raqamlar uchun: operator kodi va nollar tekshirilmaydi. */
export function normalizeUzPhone(raw: string, strict = true): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("998")) digits = digits.slice(3);
  else if (digits.length !== 9) return null;
  if (!strict) return `+998${digits}`;
  if (!UZ_CODES.has(digits.slice(0, 2))) return null;
  // "900 000 000" kabi narxlarni raqam deb olmaslik uchun
  if ((digits.slice(2).match(/0/g)?.length ?? 0) >= 5) return null;
  return `+998${digits}`;
}

export function extractPhones(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(CANDIDATE)) {
      // Bitta nomzodda ketma-ket bir nechta raqam bo'lishi mumkin ("90-123-45-67 93-765-43-21")
      const digits = match[0].replace(/\D/g, "");
      let i = 0;
      while (i < digits.length) {
        const full = digits.startsWith("998", i) ? normalizeUzPhone(digits.slice(i, i + 12)) : null;
        const local = full ? null : normalizeUzPhone(digits.slice(i, i + 9));
        if (full || local) {
          found.add((full ?? local) as string);
          i += full ? 12 : 9;
        } else if (digits[i] === "8") {
          i++; // eski "8 90 ..." formatidagi prefiks
        } else break;
      }
    }
  }
  return [...found];
}

/** +998901234567 → +998 90 123-45-67 */
export function formatPhone(phone: string): string {
  const m = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return m ? `+998 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : phone;
}
