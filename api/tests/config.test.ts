import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults when no env vars are set", () => {
    const config = loadConfig({});
    expect(config.PORT).toBe(3001);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.NODE_ENV).toBe("development");
    expect(config.DATABASE_PATH).toBe("./data/kangops.sqlite");
  });

  it("coerces PORT from a string env var", () => {
    const config = loadConfig({ PORT: "8080" });
    expect(config.PORT).toBe(8080);
  });

  it("throws with a readable message on invalid input, not a raw zod dump", () => {
    expect(() => loadConfig({ NODE_ENV: "not-a-real-env" })).toThrowError(/Invalid configuration/);
  });
});
