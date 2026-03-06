import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";

export const lookupServiceStatusTool = defineTool({
  name: "lookup_service_status",
  description: "Look up the current status of a named service.",
  inputSchema: s.object(
    {
      service: s.string({ minLength: 1 }),
    },
    { required: ["service"] },
  ),
  execute: async ({ service }) => {
    const serviceName = service.toLowerCase();
    if (serviceName === "payments" || serviceName === "checkout") {
      return {
        service,
        status: "degraded",
        suspectedCause: "Recent deploy increased timeout rates.",
      };
    }

    return {
      service,
      status: "healthy",
      suspectedCause: null,
    };
  },
}) satisfies ToolSpec;
