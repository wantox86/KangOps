import { describe, expect, it } from "vitest";
import { shouldSendAlert } from "../src/alerts/cooldown.js";

describe("shouldSendAlert", () => {
  it("allows sending when there is no prior alert", () => {
    expect(shouldSendAlert(null, "2026-01-01T00:10:00.000Z", 30)).toBe(true);
  });

  it("blocks sending inside the cooldown window", () => {
    expect(shouldSendAlert("2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z", 30)).toBe(false);
  });

  it("allows sending exactly at the cooldown boundary", () => {
    expect(shouldSendAlert("2026-01-01T00:00:00.000Z", "2026-01-01T00:30:00.000Z", 30)).toBe(true);
  });

  it("allows sending once the cooldown window has passed", () => {
    expect(shouldSendAlert("2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z", 30)).toBe(true);
  });
});
