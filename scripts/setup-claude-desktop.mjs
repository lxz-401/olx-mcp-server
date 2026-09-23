#!/usr/bin/env node
// Claude Desktop (va Cowork) konfiguratsiyasiga "olx" MCP serverini qo'shadi: npm run setup:claude
// Windows (oddiy va Microsoft Store versiyasi), macOS va Linux'ni qo'llab-quvvatlaydi.
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "olx";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(projectRoot, "dist", "index.js");

function candidateConfigs() {
  const home = homedir();
  if (platform() === "win32") {
    const list = [];
    const packages = join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Packages");
    if (existsSync(packages)) {
      for (const dir of readdirSync(packages)) {
        if (/^(AnthropicPBC\.)?Claude_/i.test(dir)) {
          list.push(join(packages, dir, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
        }
      }
    }
    list.push(join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json"));
    return list;
  }
  if (platform() === "darwin") return [join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")];
  return [join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json")];
}

if (!existsSync(entry)) {
  console.error(`dist/index.js topilmadi. Avval "npm install" (yoki "npm run build") ni bajaring.`);
  process.exit(1);
}

const candidates = candidateConfigs();
// Mavjud konfiguratsiyalar (yoki ilova papkasi mavjud bo'lganlar); hech biri bo'lmasa — birinchi nomzod.
let targets = candidates.filter((p) => existsSync(p) || existsSync(dirname(p)));
if (!targets.length) targets = [candidates[0]];

for (const configPath of targets) {
  let config = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      console.error(`${configPath} — JSON xato, o'zgartirilmadi. Faylni tuzating va qayta urinib ko'ring.`);
      process.exitCode = 1;
      continue;
    }
    const backup = `${configPath}.bak-olx`;
    if (!existsSync(backup)) copyFileSync(configPath, backup); // asl nusxa faqat bir marta saqlanadi
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }
  config.mcpServers ??= {};
  config.mcpServers[SERVER_NAME] = { command: process.execPath, args: [entry] };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`✅ "${SERVER_NAME}" qo'shildi: ${configPath}`);
}

console.log(`
Keyingi qadamlar:
  1. OLX akkauntiga kiring:      npm run login
  2. Claude Desktop'ni TO'LIQ yoping (tray → Quit) va qayta oching — Chat va Cowork'da OLX toollari paydo bo'ladi.`);
