#!/usr/bin/env node
/**
 * OLX MCP server (olx.uz).
 *  - Akkaunt: profil, e'lonlarim va statistika, e'lonni boshqarish — foydalanuvchining brauzer sessiyasi (cookie) orqali
 *  - Bozor: qidiruv, raqobatchilarni aniqlash, narx tahlili — saytning ochiq API'si orqali
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAccountTools } from "./tools/account.js";
import { registerMyAdsTools } from "./tools/myads.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerMarketTools } from "./tools/market.js";
import { closeBrowser } from "./services/browser.js";
import { OLX_BASE_URL } from "./constants.js";

const server = new McpServer({ name: "olx-mcp-server", version: "2.0.0" });

registerAccountTools(server);
registerMyAdsTools(server);
registerReferenceTools(server);
registerMarketTools(server);

async function shutdown(): Promise<void> {
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("close", () => void shutdown());

await server.connect(new StdioServerTransport());
console.error(`olx-mcp-server ishga tushdi (${OLX_BASE_URL}, stdio)`);
