import { describe, expect, it } from "vitest";
import { buildDependencyView } from "../src/dependencies/view.js";
import type { Container, DependencyAnnotation } from "../src/db/schema.js";

function container(overrides: Partial<Container> = {}): Container {
  return {
    dockerId: "c1",
    hostId: "local",
    currentName: "web",
    imageRef: "nginx:latest",
    imageDigest: null,
    composeProject: "proj",
    composeService: "web",
    currentState: "running",
    currentHealth: "healthy",
    restartCount: 0,
    critical: false,
    firstSeenAt: "t",
    lastSeenAt: "t",
    ...overrides,
  };
}

describe("buildDependencyView", () => {
  it("groups containers that share a Compose project and labels the group as weak/non-causal", () => {
    const view = buildDependencyView(
      [container({ dockerId: "c1", composeProject: "proj" }), container({ dockerId: "c2", composeProject: "proj" })],
      [],
    );
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]).toMatchObject({ composeProject: "proj", source: "compose_project", confidence: "weak", containerIds: ["c1", "c2"] });
    expect(view.groups[0]?.note).toMatch(/does not confirm/i);
  });

  it("does not create a group for a lone container in a project", () => {
    const view = buildDependencyView([container({ dockerId: "c1", composeProject: "proj" })], []);
    expect(view.groups).toHaveLength(0);
  });

  it("ignores standalone containers with no compose project", () => {
    const view = buildDependencyView([container({ composeProject: null })], []);
    expect(view.groups).toHaveLength(0);
  });

  it("surfaces user annotations as declared-confidence edges", () => {
    const annotation: DependencyAnnotation = { id: 1, fromContainerId: "c1", toContainerId: "c2", note: "c1 calls c2's API", createdAt: "t" };
    const view = buildDependencyView([container({ dockerId: "c1" }), container({ dockerId: "c2" })], [annotation]);
    expect(view.annotations).toEqual([{ id: 1, fromContainerId: "c1", toContainerId: "c2", note: "c1 calls c2's API", source: "user_annotation", confidence: "declared", createdAt: "t" }]);
  });
});
