export class OlxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OlxApiError";
  }
}

/** Sessiya yo'q yoki eskirgan — foydalanuvchi qayta kirishi kerak. */
export class OlxSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OlxSessionError";
  }
}

const LOGIN_HINT =
  "OLX akkauntiga kirish kerak: `olx_login` toolini chaqiring (Chrome oynasi ochiladi, foydalanuvchi o'zi kiradi) " +
  "yoki terminalda `npm run login`.";

/** Har qanday xatoni agent tushunadigan, keyingi qadamni ko'rsatuvchi matnga aylantiradi. */
export function describeError(error: unknown): string {
  if (error instanceof OlxSessionError) return `Xato (sessiya): ${error.message}\n${LOGIN_HINT}`;
  if (error instanceof OlxApiError) {
    const lines = [`Xato: OLX ${error.status} — ${error.message}`];
    switch (error.status) {
      case 403:
        lines.push("Ruxsat yo'q yoki bot himoyasi. Birozdan so'ng qayta urinib ko'ring.");
        break;
      case 404:
        lines.push("Topilmadi: ID to'g'riligini tekshiring.");
        break;
      case 429:
        lines.push("So'rovlar limiti oshdi. Biroz kutib qayta urinib ko'ring.");
        break;
    }
    return lines.join("\n");
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "Xato: OLX javob bermadi (timeout). Keyinroq qayta urinib ko'ring.";
    }
    return `Xato: ${error.message}`;
  }
  return `Xato: ${String(error)}`;
}
