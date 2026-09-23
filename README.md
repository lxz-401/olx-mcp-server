# olx-mcp-server

OLX.uz uchun MCP server. Claude (yoki boshqa MCP klient) orqali:

- **Profil**: akkaunt ma'lumotlari, e'lonlar soni holatlar bo'yicha, OLX hisob balansi, telefon tasdiqlanganligi
- **Mening e'lonlarim**: ro'yxat va statistika (ko'rishlar, telefon ko'rishlar, saqlaganlar, xabarlar), kunlik statistika tarixi,
  faollashtirish / o'chirib qo'yish / ko'tarish / uzaytirish / o'chirish
- **Raqobatchilar**: segmentdagi asosiy sotuvchilar, ularning profili va e'lonlari
- **Bozor tahlili**: narx statistikasi (median, 25/75%), bozor tuzilmasi, reklama ulushi, tavsiyalar; o'z e'loningizni raqobatchilar bilan solishtirish
- **E'lon joylash**: tayyorlanmoqda (pastga qarang)

## Qanday ishlaydi

Rasmiy OLX Partner API O'zbekiston uchun ochiq emas, shuning uchun server **sizning brauzer sessiyangiz (cookie'lar)** orqali
ishlaydi — xuddi olx.uz saytining o'zi kabi:

| Qism | Manba | Kerak |
|---|---|---|
| Profil, e'lonlarim, e'lon boshqaruvi | olx.uz `/api/v1/users/me/...` + OLX GraphQL (`myAds`) | OLX'ga kirish (`olx_login`) |
| Qidiruv, raqobatchilar, bozor tahlili | olx.uz ochiq qidiruv API'si | Hech narsa |
| Kategoriyalar, parametrlar, joylar | categories.olxcdn.com, GraphQL, geo API | Hech narsa |

- Sessiya `~/.olx-mcp/session.json` da saqlanadi. **Bu fayl akkauntingizga kirish kalitiga teng — hech kimga bermang.**
- `access_token` 15 daqiqa amal qiladi; server uni saytning o'zi kabi avtomatik yangilaydi (login.olx.uz sessiyasi orqali).
  Sessiya butunlay eskirsa (odatda ~2 hafta faolsizlikdan keyin) — qayta kiring.
- olx.uz oddiy HTTP so'rovlarni bloklaydi, shuning uchun so'rovlar kompyuterdagi **Google Chrome yoki Microsoft Edge**ning
  ko'rinmas (headless) rejimi orqali yuboriladi. Brauzer 2 daqiqa ishlatilmasa yopiladi.
- Bozor tahlili so'rovlari akkauntsiz (anonim) yuboriladi.

> ⚠️ Norasmiy loyiha — OLX bilan bog'liq emas. Saytning ichki API'larini ishlatadi. OLX ularni o'zgartirsa, moslash kerak bo'ladi. OLX qoidalari
> avtomatlashtirishni cheklashi mumkin — so'rovlarni me'yorida yuboring, ommaviy e'lon joylash uchun ishlatmang.

## Toollar

**Akkaunt**: `olx_login`, `olx_session_status`, `olx_get_my_profile`

**Mening e'lonlarim**: `olx_list_my_adverts`, `olx_get_my_advert` (kunlik statistika bilan), `olx_advert_action`
(activate / deactivate / refresh / extend / finish / remove)

**Ma'lumotnoma**: `olx_suggest_category`, `olx_list_categories`, `olx_get_category` (majburiy parametrlar va qiymatlar), `olx_find_location`

**Bozor va raqobatchilar**: `olx_search_offers`, `olx_get_offer`, `olx_get_offer_phones`, `olx_get_seller`, `olx_analyze_market`,
`olx_find_competitors`, `olx_compare_my_advert`

**Aloqa raqamlari**: `olx_get_offer_phones` 1–20 ta e'lon uchun sotuvchining telefonini ochadi (saytdagi "Показать телефон"
tugmasi bilan bir xil, login shart emas) va tavsifga yozilgan raqamlarni ham ajratib beradi. `olx_get_offer` tavsifdagi
raqamlarni doim ko'rsatadi, `include_phones=true` bilan esa telefonni ham ochadi. Har bir ochish sotuvchining
statistikasiga yoziladi va OLX kunlik limit qo'yadi — faqat kerakli e'lonlar uchun so'rang.

## O'rnatish (istalgan qurilmada)

Talablar: [Node.js 20+](https://nodejs.org), Google Chrome yoki Microsoft Edge, Claude Desktop.

```bash
git clone https://github.com/lxz-401/olx-mcp-server.git
cd olx-mcp-server
npm install              # bog'liqliklar + avtomatik build
npm run setup:claude     # Claude Desktop / Cowork konfiguratsiyasiga "olx" serverini qo'shadi
npm run login            # Chrome ochiladi — OLX akkauntingizga o'zingiz kiring
```

So'ng Claude Desktop'ni **to'liq yoping** (tray → Quit) va qayta oching. OLX toollari Chat'da ham, **Cowork**'da ham paydo bo'ladi
(Cowork mahalliy serverlarni Claude Desktop konfiguratsiyasi orqali oladi; server sizning kompyuteringizda ishlaydi).

- `setup:claude` Windows (oddiy va Microsoft Store versiyasi), macOS va Linux'dagi konfiguratsiya faylini o'zi topadi,
  mavjud sozlamalarni saqlaydi va asl faylning zaxirasini `claude_desktop_config.json.bak-olx` ga oladi.
- Har bir qurilmada alohida `npm run login` qiling. `session.json` ni qurilmalar o'rtasida ko'chirmang va hech qachon
  git'ga qo'shmang (u repo tashqarisida, `~/.olx-mcp/` da saqlanadi).
- Yangilash: `git pull && npm install`, keyin Claude Desktop'ni qayta ishga tushiring.

### Qo'lda ulash

**Claude Code:**

```bash
claude mcp add olx --scope user -- node "/to'liq/yo'l/olx-mcp-server/dist/index.js"
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "olx": {
      "command": "node",
      "args": ["/to'liq/yo'l/olx-mcp-server/dist/index.js"]
    }
  }
}
```

Konfiguratsiya fayli joyi: Windows — `%APPDATA%\Claude\` yoki Store versiyasida
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`; macOS — `~/Library/Application Support/Claude/`.

## E'lon joylash

OLX e'lon joylashdan oldin **telefon raqamini SMS orqali bir marta tasdiqlashni** talab qiladi. Buni olx.uz saytida yoki OLX
ilovasida o'zingiz bajaring ("Подать объявление" → telefon → SMS kod). `olx_session_status` tasdiqlanganligini ko'rsatadi.
Shundan so'ng `olx_create_advert` tooli qo'shiladi.

## Sozlamalar (muhit o'zgaruvchilari)

| O'zgaruvchi | Default | Tavsif |
|---|---|---|
| `OLX_SESSION_FILE` | `~/.olx-mcp/session.json` | Sessiya (cookie) fayli |
| `OLX_LANG` | `ru` | Javoblar tili (`ru` yoki `uz`) |
| `OLX_BROWSER_CHANNEL` | `chrome`, keyin `msedge` | Qaysi brauzer ishlatilsin |
| `OLX_BROWSER_PATH` | — | Brauzer exe fayliga to'liq yo'l |
| `OLX_HEADLESS` | `true` | `false` — brauzer oynasini ko'rsatish (debug) |
| `OLX_BASE_URL`, `OLX_SITE_CODE` | `https://www.olx.uz`, `olxuz` | Boshqa mamlakat OLX'i uchun |

## Misol so'rovlar

- "Profilimni va e'lonlarim statistikasini ko'rsat" → `olx_get_my_profile`, `olx_list_my_adverts status=ALL`
- "iPhone 13 128GB ni Toshkentda qanchaga sotsam bo'ladi?" → `olx_find_location` + `olx_analyze_market`
- "Kir yuvish mashinalari bo'yicha asosiy raqobatchilarim kim?" → `olx_find_competitors` → `olx_get_seller`
- "12345 raqamli e'lonimni raqobatchilar bilan solishtir" → `olx_compare_my_advert`
- "Toshkentdagi arzon iPhone 13 sotuvchilarining raqamlarini ber" → `olx_search_offers sort=price_asc` → `olx_get_offer_phones`

## Tekshirish

```bash
node scripts/smoke-test.mjs '[["olx_session_status",{}],["olx_search_offers",{"query":"iphone","limit":3}]]'
```
