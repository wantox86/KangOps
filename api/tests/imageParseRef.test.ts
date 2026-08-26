import { describe, expect, it } from "vitest";
import { parseImageRef } from "../src/images/parseRef.js";

describe("parseImageRef", () => {
  it("parses a bare official-image name with an implicit 'library' namespace and 'latest' tag", () => {
    expect(parseImageRef("nginx")).toEqual({ namespace: "library", repo: "nginx", tag: "latest" });
  });

  it("parses a bare official-image name with an explicit tag", () => {
    expect(parseImageRef("nginx:1.27")).toEqual({ namespace: "library", repo: "nginx", tag: "1.27" });
  });

  it("parses a user/repo reference", () => {
    expect(parseImageRef("tecnativa/docker-socket-proxy")).toEqual({ namespace: "tecnativa", repo: "docker-socket-proxy", tag: "latest" });
  });

  it("parses a user/repo:tag reference", () => {
    expect(parseImageRef("tecnativa/docker-socket-proxy:0.2.0")).toEqual({ namespace: "tecnativa", repo: "docker-socket-proxy", tag: "0.2.0" });
  });

  it("strips a digest suffix", () => {
    expect(parseImageRef("nginx@sha256:abcd1234")).toEqual({ namespace: "library", repo: "nginx", tag: "latest" });
  });

  it("returns null for an explicit third-party registry host", () => {
    expect(parseImageRef("ghcr.io/foo/bar:latest")).toBeNull();
  });

  it("returns null for a host:port registry reference", () => {
    expect(parseImageRef("registry.example.com:5000/foo/bar")).toBeNull();
  });

  it("returns null for a localhost registry reference", () => {
    expect(parseImageRef("localhost/foo/bar")).toBeNull();
  });
});
