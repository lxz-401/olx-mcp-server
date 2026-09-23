#!/usr/bin/env node
/**
 * OLX akkauntiga brauzer orqali kirish: `npm run login`
 * Chrome oynasi ochiladi, foydalanuvchi o'zi kiradi; kirish aniqlangach cookie'lar SESSION_FILE ga saqlanadi.
 */
import { SESSION_FILE } from "./constants.js";
import { interactiveLogin } from "./services/session.js";

const TIMEOUT_MS = 10 * 60_000;

console.log(`Kutilmoqda (maksimal ${TIMEOUT_MS / 60_000} daqiqa)...`);
const ok = await interactiveLogin(TIMEOUT_MS, (msg) => console.log(msg));
if (ok) {
  console.log(`\nKirish muvaffaqiyatli ✅ Sessiya saqlandi: ${SESSION_FILE}`);
} else {
  console.error("\nKirish aniqlanmadi (vaqt tugadi yoki oyna yopildi).");
  process.exitCode = 1;
}
