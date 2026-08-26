export interface DockerHubRef {
  namespace: string;
  repo: string;
  tag: string;
}

// Pure parser (fixture-tested) that recognizes ONLY Docker Hub image references -- deliberately
// narrow. Multi-registry support (ghcr.io, a private registry, GitLab, etc.) needs per-registry
// auth flows that are real scope, not a one-line addition; rather than half-implement that,
// anything with an explicit registry host is reported as unsupported so the update-center UI
// can say "not checked (unsupported registry)" honestly instead of silently doing nothing.
// Recognized shapes: "nginx" / "nginx:tag" (implicit "library" namespace), "user/repo[:tag]".
// Unsupported: anything with a host component before the first "/" (contains "." or ":", or is
// exactly "localhost") -- e.g. "ghcr.io/foo/bar", "registry.example.com:5000/foo".
export function parseImageRef(imageRef: string): DockerHubRef | null {
  // Strip a "@sha256:..." digest suffix first if present, e.g. "nginx@sha256:abcd" -- the digest
  // isn't a tag, and this repo doesn't need it (we look up the *latest* digest ourselves).
  const withoutDigest = imageRef.split("@")[0]!;
  const [namePart, tagPart] = splitTag(withoutDigest);
  const tag = tagPart ?? "latest";

  const segments = namePart.split("/");
  const first = segments[0];
  if (first === undefined) return null;

  const looksLikeHost = first.includes(".") || first.includes(":") || first === "localhost";
  if (looksLikeHost) return null;

  if (segments.length === 1) {
    return { namespace: "library", repo: segments[0]!, tag };
  }
  if (segments.length === 2) {
    return { namespace: segments[0]!, repo: segments[1]!, tag };
  }
  // 3+ segments without a host-looking first segment doesn't happen for real Docker Hub refs.
  return null;
}

// Splits "repo:tag" from the end only, so a namespace like "user/repo" (no colon) or a repo
// with a port-looking host isn't confused with a tag separator.
function splitTag(imageRef: string): [string, string | undefined] {
  const lastColon = imageRef.lastIndexOf(":");
  const lastSlash = imageRef.lastIndexOf("/");
  if (lastColon > lastSlash) {
    return [imageRef.slice(0, lastColon), imageRef.slice(lastColon + 1)];
  }
  return [imageRef, undefined];
}
