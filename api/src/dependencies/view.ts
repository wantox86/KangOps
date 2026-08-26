import type { Container, DependencyAnnotation } from "../db/schema.js";

export interface ComposeGroup {
  composeProject: string;
  source: "compose_project";
  confidence: "weak";
  note: string;
  containerIds: string[];
}

export interface AnnotationEdge {
  id: number;
  fromContainerId: string;
  toContainerId: string;
  note: string | null;
  source: "user_annotation";
  confidence: "declared";
  createdAt: string;
}

export interface DependencyView {
  groups: ComposeGroup[];
  annotations: AnnotationEdge[];
}

// Pure, conservative-by-construction view (fixture-tested in tests/dependencyView.test.ts). Per
// CLAUDE.md's dependency-map guidance: "Label confidence/source... Do not imply causal runtime
// dependencies from shared networks alone." This repo doesn't collect Docker network membership
// at all (the read adapter never inspects networks -- see docker/types.ts), so there is nothing
// to imply from "shared networks" here; the only two sources are Compose-project co-membership
// (explicitly labeled "weak"/non-causal -- containers in the same project are *often* related,
// but this says nothing about actual startup order or runtime calls) and explicit user
// annotations (labeled "declared", the only source treated as an intentional edge).
export function buildDependencyView(containers: Container[], annotations: DependencyAnnotation[]): DependencyView {
  const byProject = new Map<string, string[]>();
  for (const container of containers) {
    if (!container.composeProject) continue;
    const list = byProject.get(container.composeProject) ?? [];
    list.push(container.dockerId);
    byProject.set(container.composeProject, list);
  }

  const groups: ComposeGroup[] = [...byProject.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([composeProject, containerIds]) => ({
      composeProject,
      source: "compose_project" as const,
      confidence: "weak" as const,
      note: "Containers share a Compose project. This does not confirm an actual runtime dependency.",
      containerIds,
    }));

  const edges: AnnotationEdge[] = annotations.map((a) => ({
    id: a.id,
    fromContainerId: a.fromContainerId,
    toContainerId: a.toContainerId,
    note: a.note,
    source: "user_annotation" as const,
    confidence: "declared" as const,
    createdAt: a.createdAt,
  }));

  return { groups, annotations: edges };
}
