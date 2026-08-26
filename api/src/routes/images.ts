import type { FastifyInstance } from "fastify";
import { containers } from "../db/schema.js";
import type { DbClient } from "../db/client.js";
import { getImageMetadata } from "../images/metadataRepo.js";
import { getRegistryConfig, registryConfigSchema, saveRegistryConfig } from "../images/registryConfigRepo.js";

const imageEntrySchema = {
  type: "object",
  required: ["dockerId", "name", "imageRef", "currentDigest", "registryChecked", "registrySupported", "latestDigest", "updateAvailable", "checkedAt", "checkError"],
  properties: {
    dockerId: { type: "string" },
    name: { type: "string" },
    imageRef: { type: "string" },
    currentDigest: { type: ["string", "null"] },
    registryChecked: { type: "boolean" },
    registrySupported: { type: ["boolean", "null"] },
    latestDigest: { type: ["string", "null"] },
    updateAvailable: { type: ["boolean", "null"] },
    checkedAt: { type: ["string", "null"] },
    checkError: { type: ["string", "null"] },
  },
} as const;

const imagesResponseSchema = {
  type: "object",
  required: ["registryCheckEnabled", "items"],
  properties: {
    registryCheckEnabled: { type: "boolean" },
    items: { type: "array", items: imageEntrySchema },
  },
} as const;

const registryConfigResponseSchema = {
  type: "object",
  required: ["enabled"],
  properties: { enabled: { type: "boolean" } },
} as const;

// GET /api/v1/images: local-only image/tag/digest facts (currentDigest, from the collector's
// own observations) are always shown; latestDigest/updateAvailable only ever populate once a
// user explicitly enables registry_check_config (GET/PUT /api/v1/settings/registry) -- never an
// implicit network call, per CLAUDE.md's opt-in requirement for the update center.
export function registerImageRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/images", { schema: { response: { 200: imagesResponseSchema } } }, async () => {
    const registryConfig = getRegistryConfig(db);
    const rows = db.select().from(containers).all();

    const items = rows.map((row) => {
      const metadata = getImageMetadata(db, row.imageRef);
      const currentDigest = row.imageDigest;
      const latestDigest = metadata?.latestDigest ?? null;
      const updateAvailable = registryConfig.enabled && currentDigest && latestDigest ? currentDigest !== latestDigest : null;

      return {
        dockerId: row.dockerId,
        name: row.currentName,
        imageRef: row.imageRef,
        currentDigest,
        registryChecked: metadata !== undefined,
        registrySupported: metadata?.registrySupported ?? null,
        latestDigest,
        updateAvailable,
        checkedAt: metadata?.lastCheckedAt ?? null,
        checkError: metadata?.checkError ?? null,
      };
    });

    return { registryCheckEnabled: registryConfig.enabled, items };
  });

  app.get("/api/v1/settings/registry", { schema: { response: { 200: registryConfigResponseSchema } } }, async () => {
    return getRegistryConfig(db);
  });

  app.put("/api/v1/settings/registry", { schema: { response: { 200: registryConfigResponseSchema } } }, async (request, reply) => {
    const parsed = registryConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    saveRegistryConfig(db, parsed.data, new Date().toISOString());
    return parsed.data;
  });
}
