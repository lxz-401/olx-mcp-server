// MCP serverni stdio orqali ishga tushirib, toollarni sinab ko'radi: node scripts/smoke-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env } }));

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}):`, tools.map((t) => t.name).join(", "));

const calls = JSON.parse(process.argv[2] ?? "[]");
for (const [name, args] of calls) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text).join("\n");
  console.log(`\n===== ${name} ${JSON.stringify(args)} (${Date.now() - started} ms)${res.isError ? " [ERROR]" : ""}\n${text.slice(0, 2500)}`);
}
await client.close();
