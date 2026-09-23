/**
 * Discovery probe for the QSC broadcast hub. Run it on the client network (VPN /
 * office LAN) to confirm the transport, the client method names and the payload
 * shape before trusting the feed. Read-only: nothing is written to the database.
 *
 *   cd backend && npx tsx scripts/probe-hub.ts
 *   npx tsx scripts/probe-hub.ts http://192.168.41.201/qscapi/hub 60
 */
import "dotenv/config";
import * as signalR from "@microsoft/signalr";
import { parseBroadcastPayload } from "../src/services/market-broadcast.js";

const url = (process.argv[2] || process.env.BROADCAST_WS_URL || "").trim();
const seconds = Number(process.argv[3] || 45);

/** Names we already listen for, plus the object names QSC used in meeting 3. */
const CANDIDATE_METHODS = [
  "broadcastMessage",
  "BroadcastMessage",
  "broadcastData",
  "BroadcastData",
  "ReceiveMessage",
  "receiveMessage",
  "onMessage",
  "MarketWatch",
  "ExchangesSummary",
  "MarketIndicies",
  "trades",
  "MarketDepthByPrice",
];

async function main() {
  if (!url) {
    console.error("No hub URL. Pass it as argv[2] or set BROADCAST_WS_URL.");
    process.exit(1);
  }
  console.log(`[probe] hub   : ${url}`);
  console.log(`[probe] listen: ${seconds}s`);

  // negotiate is plain HTTP — check it first so a network/routing problem is obvious.
  const negotiateUrl = `${url.replace(/\/$/, "")}/negotiate?negotiateVersion=1`;
  try {
    const res = await fetch(negotiateUrl, { method: "POST" });
    console.log(`[probe] negotiate HTTP ${res.status}`);
    console.log(`[probe] negotiate body ${(await res.text()).slice(0, 600)}`);
  } catch (err) {
    console.error(`[probe] negotiate failed: ${err instanceof Error ? err.message : err}`);
    console.error("[probe] If this is a network error the host is not reachable from here (VPN?).");
  }

  // Same transport as the server: Skip Negotiation + WebSockets, like the QSC sample.
  const skipNegotiation = process.env.BROADCAST_HUB_NEGOTIATE !== "1";
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(url, {
      skipNegotiation,
      transport: signalR.HttpTransportType.WebSockets,
      withCredentials: false,
    })
    .configureLogging(signalR.LogLevel.Information)
    .build();

  const seen = new Map<string, number>();
  for (const name of CANDIDATE_METHODS) {
    connection.on(name, (...args: unknown[]) => {
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      if (count > 2) return; // first two of each method is enough to read the shape
      console.log(`\n[probe] ── ${name} (message ${count}) argc=${args.length}`);
      for (const [i, arg] of args.entries()) {
        const value = typeof arg === "string" ? tryJson(arg) : arg;
        console.log(`[probe] arg${i} type=${typeof arg} keys=${keysOf(value)}`);
        console.log(`[probe] arg${i} head=${JSON.stringify(value).slice(0, 900)}`);
        try {
          const parsed = parseBroadcastPayload(value);
          console.log(
            `[probe] arg${i} parsed → quotes=${parsed.quotes.length} indices=${parsed.indices.length} exchange=${parsed.exchange ? "yes" : "no"}`,
          );
          const first = parsed.quotes[0];
          if (first) {
            console.log(
              `[probe] sample quote ${first.symbol} last=${first.lastTradePrice} close=${first.closePrice} trades=${first.trades} vol=${first.totalVolume}`,
            );
          }
        } catch (err) {
          console.log(`[probe] arg${i} parse error: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }

  connection.onclose((err) => console.log(`[probe] closed ${err?.message ?? ""}`));

  try {
    await connection.start();
    console.log(`[probe] connected (WebSockets, skipNegotiation=${skipNegotiation})`);
  } catch (err) {
    console.error(`[probe] start failed: ${err instanceof Error ? err.message : err}`);
    if (skipNegotiation) console.error("[probe] Retry with BROADCAST_HUB_NEGOTIATE=1 if the hub requires the handshake.");
    process.exit(2);
  }

  const invokes = (process.env.BROADCAST_HUB_INVOKE || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const method of invokes) {
    try {
      const out = await connection.invoke(method);
      console.log(`[probe] invoke ${method} → ${JSON.stringify(out).slice(0, 400)}`);
    } catch (err) {
      console.log(`[probe] invoke ${method} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  await new Promise((r) => setTimeout(r, seconds * 1000));
  console.log(`\n[probe] messages per method: ${JSON.stringify([...seen.entries()])}`);
  if (seen.size === 0) {
    console.log("[probe] Nothing arrived. Either the session is closed, or the hub needs a");
    console.log("[probe] subscribe call (set BROADCAST_HUB_INVOKE=MethodName), or the method");
    console.log("[probe] name differs — look for 'No client method with the name' warnings above.");
  }
  await connection.stop();
  process.exit(0);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function keysOf(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.keys(value).slice(0, 25).join(",");
  if (Array.isArray(value)) return `array[${value.length}]`;
  return "-";
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
