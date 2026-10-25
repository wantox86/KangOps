import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { networkSnapshotSchema } from "../src/network/payload.js";

// Runs the REAL agent/network.jq against a synthetic ASUSWRT get_clientlist() fixture (made-up
// locally administered MACs, no real inventory). The fixture's shape comes from known ASUSWRT
// behaviour, not from the live firmware -- see CLAUDE.md for what has/hasn't been verified live.
const agentDir = resolve(__dirname, "../../agent");
const hasJq = spawnSync("jq", ["--version"]).status === 0;

function parse(input: unknown): { collectorVersion: string; devices: Array<Record<string, unknown>> } {
  const result = spawnSync("jq", ["-c", "--arg", "version", "test", "-f", resolve(agentDir, "network.jq")], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { collectorVersion: string; devices: Array<Record<string, unknown>> };
}

describe.skipIf(!hasJq)("agent/network.jq", () => {
  const fixture = readFileSync(resolve(agentDir, "fixtures/asus-clientlist.json"), "utf8");

  it("keeps only online, non-gateway clients and normalises fields", () => {
    const out = parse(fixture);
    expect(out.collectorVersion).toBe("test");
    expect(out.devices).toEqual([
      { mac: "02:00:00:00:00:01", ip: "192.168.50.20", hostname: "synthetic-laptop", vendor: "ExampleCorp" },
      // nickName (router-side alias) wins over the announced name; empty vendor -> null.
      { mac: "02:00:00:00:00:02", ip: "192.168.50.21", hostname: "Pixel Rina", vendor: null },
      // numeric isOnline tolerated; whitespace-only name -> null.
      { mac: "02:00:00:00:00:04", ip: "192.168.50.23", hostname: null, vendor: "Lowercase Inc" },
    ]);
  });

  it("skips maclist / ClientAPILevel siblings and falls back to the map key for a missing mac", () => {
    const out = parse({ get_clientlist: { "02:00:00:00:00:09": { ip: "192.168.50.9", isOnline: "1" }, maclist: ["x"], ClientAPILevel: "2" } });
    expect(out.devices).toEqual([{ mac: "02:00:00:00:00:09", ip: "192.168.50.9", hostname: null, vendor: null }]);
  });

  it("uppercases MACs", () => {
    const out = parse({ get_clientlist: { x: { mac: "aa:bb:cc:dd:ee:ff", isOnline: "1" } } });
    expect(out.devices[0]?.mac).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("yields an empty list for an unexpected shape rather than failing", () => {
    expect(parse({ get_clientlist: {} }).devices).toEqual([]);
    expect(parse({}).devices).toEqual([]);
  });

  it("produces output the API's ingest schema accepts", () => {
    expect(networkSnapshotSchema.safeParse(parse(fixture)).success).toBe(true);
  });
});
