import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasSessionFile, interactiveLogin, sessionRest } from "../services/session.js";
import { formatted, money, responseFormatSchema, safe, shortDate, textResult } from "../services/format.js";
import { SESSION_FILE } from "../constants.js";
import type { OlxUser } from "../types.js";

interface Counters {
  ads: Record<string, number>;
  observed: { ads: number; searches: number };
}

interface WalletSummary {
  total: { value: number; unit: string };
  wallet: { value: number; unit: string };
  bonus: { value: number; unit: string };
  refund: { value: number; unit: string };
}

interface ContactDetails {
  person?: string;
  phone?: string | null;
  city?: unknown;
  district?: unknown;
}

async function optional<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

async function getMe(): Promise<OlxUser> {
  return (await sessionRest<{ data: OlxUser }>("GET", "/users/me/")).data;
}

async function isPhoneVerified(): Promise<boolean | null> {
  const res = await optional(sessionRest<{ data: { is_user_verified: boolean } }>("GET", "/users/me/sms-verification/"));
  return res ? res.data.is_user_verified : null;
}

const STATUS_LABELS: Record<string, string> = {
  active: "faol",
  waiting: "kutilmoqda",
  moderated: "moderatsiyada",
  archive: "arxiv",
  unpaid: "to'lanmagan",
  outdated: "muddati o'tgan",
};

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "olx_login",
    {
      title: "OLX akkauntiga kirish",
      description: `Open a visible Chrome window on the user's computer so THEY can log into their OLX account (phone/email + password or SMS code).
The tool never types credentials; it only waits until login is detected (up to wait_minutes) and saves the session cookies locally.
Call this when any account tool returns a session error. Tell the user a Chrome window has opened and they should log in there.`,
      inputSchema: {
        wait_minutes: z.number().int().min(1).max(15).default(5).describe("Kirishni necha daqiqa kutish"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ wait_minutes }) => {
      const ok = await interactiveLogin(wait_minutes * 60_000);
      if (!ok) return { isError: true, content: [{ type: "text", text: "Kirish aniqlanmadi (vaqt tugadi yoki oyna yopildi). Qayta urinib ko'ring." }] };
      const me = await getMe();
      return textResult(`OLX akkauntiga kirildi ✅ ${me.name} (ID ${me.id}). Sessiya saqlandi: ${SESSION_FILE}`);
    }),
  );

  server.registerTool(
    "olx_session_status",
    {
      title: "OLX sessiya holati",
      description: `Check whether an OLX account session is saved and valid, which account it is, and whether the phone is SMS-verified
(OLX requires a verified phone before posting adverts). Competitor/market tools do not need a session.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async () => {
      if (!hasSessionFile()) return textResult("Sessiya yo'q — `olx_login` bilan kiring.");
      const [me, verified] = await Promise.all([getMe(), isPhoneVerified()]);
      return textResult(
        [
          `Sessiya faol ✅ — ${me.name} (ID ${me.id})`,
          `Telefon SMS orqali tasdiqlangan: ${verified === null ? "noma'lum" : verified ? "ha" : "YO'Q — e'lon joylashdan oldin olx.uz saytida telefonni tasdiqlang"}`,
          `Sessiya fayli: ${SESSION_FILE}`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "olx_get_my_profile",
    {
      title: "Mening OLX profilim",
      description: `Get the logged-in OLX account profile: name, id, registration date, last login, business flag, phone verification,
contact details used in adverts, advert counters by status (active / waiting / moderated / archive / unpaid / outdated),
saved (observed) ads and searches, and OLX wallet balance.
For the advert list with views/phone stats use olx_list_my_adverts.`,
      inputSchema: { response_format: responseFormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ response_format }) => {
      const me = await getMe();
      const [counters, wallet, verified, contact] = await Promise.all([
        optional(sessionRest<{ data: Counters }>("GET", "/users/me/counters/", { version: "v1.21" }).then((r) => r.data)),
        optional(sessionRest<{ data: WalletSummary }>("GET", "/users/me/wallet/summary/").then((r) => r.data)),
        isPhoneVerified(),
        optional(sessionRest<{ data: ContactDetails }>("GET", `/users/${me.id}/contact-details/`).then((r) => r.data)),
      ]);
      const data = { user: me, phone_verified: verified, contact_details: contact, counters, wallet };
      return formatted(response_format, data, () => {
        const lines = [
          `# OLX profil: ${me.name} (ID ${me.id})`,
          `- Turi: ${me.is_business ? "Biznes" : "Xususiy"}`,
          `- Ro'yxatdan o'tgan: ${shortDate(me.created)} · oxirgi kirish: ${shortDate(me.last_login)}`,
          `- Telefon tasdiqlangan: ${verified === null ? "—" : verified ? "ha" : "yo'q (e'lon joylash uchun kerak)"}`,
          `- E'lonlardagi kontakt: ${contact?.person ?? "—"}${contact?.phone ? `, ${contact.phone}` : ""}`,
          `- Profil sahifasi: ${me.user_ads_url ?? "—"}`,
        ];
        if (counters) {
          lines.push(
            "",
            "## E'lonlar",
            Object.entries(counters.ads)
              .map(([k, v]) => `${STATUS_LABELS[k] ?? k}: ${v}`)
              .join(" · "),
            `Saqlangan e'lonlar: ${counters.observed.ads} · saqlangan qidiruvlar: ${counters.observed.searches}`,
          );
        }
        if (wallet) {
          lines.push(
            "",
            "## OLX hisob",
            `Jami: ${money(wallet.total.value, wallet.total.unit)} · hamyon: ${money(wallet.wallet.value, wallet.wallet.unit)} · ` +
              `bonus: ${wallet.bonus.value} ${wallet.bonus.unit} · qaytarim: ${wallet.refund.value} ${wallet.refund.unit}`,
          );
        }
        return lines.join("\n");
      });
    }),
  );
}
