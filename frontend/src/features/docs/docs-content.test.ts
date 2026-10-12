import { describe, expect, it } from "vitest";
import v1Source from "../../../../backend/src/http/v1.ts?raw";
import { ENDPOINTS } from "@/features/docs/docs-content";

/** `METHOD /v1/path` for every route registered in backend/src/http/v1.ts. */
function registeredRoutes(): string[] {
  const routes = [...v1Source.matchAll(/\bv1\.(get|post|delete)\(\s*"([^"]+)"/g)].map(
    ([, method, path]) => `${method!.toUpperCase()} /v1${path}`,
  );
  return routes.sort();
}

describe("API docs endpoint table", () => {
  it("lists exactly the routes the /v1 API registers", () => {
    const documented = ENDPOINTS.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort();
    expect(registeredRoutes().length).toBeGreaterThan(10);
    expect(documented).toEqual(registeredRoutes());
  });
});
