import { COPY } from "@shade/contract";
import { describe, expect, it } from "vitest";
import html from "../index.html?raw";
import robots from "../public/robots.txt?raw";
import vercelRaw from "../vercel.json?raw";
import vercelIgnore from "../../.vercelignore?raw";

/** The parts of Vercel's legacy `routes` format that frontend/vercel.json uses. */
interface Transform {
  type: string;
  op: string;
  target: { key: string };
  args: string;
  env?: string[];
}

interface Route {
  src?: string;
  dest?: string;
  headers?: Record<string, string>;
  continue?: boolean;
  transforms?: Transform[];
  handle?: string;
  status?: number;
}

const vercel = JSON.parse(vercelRaw) as Record<string, unknown> & { routes: Route[] };
const routes = vercel.routes;

/** Vercel anchors every `src` (it is a regex over the path, without the query). */
function matches(route: Route, path: string): boolean {
  return route.src !== undefined && new RegExp(`^${route.src}$`).test(path);
}

interface Resolved {
  headers: Record<string, string>;
  route: Route | undefined;
}

/**
 * Walks the routes the way Vercel does: header routes with `continue` add their headers (a later
 * route overrides an earlier one for the same header) and the first matching route without
 * `continue` ends the walk. `fileExists` stands in for `{ "handle": "filesystem" }`.
 */
function resolve(path: string, fileExists = false): Resolved {
  const headers: Record<string, string> = {};
  for (const route of routes) {
    if (route.handle === "filesystem") {
      if (fileExists) return { headers, route };
      continue;
    }
    if (!matches(route, path)) continue;
    Object.assign(headers, route.headers);
    if (!route.continue) return { headers, route };
  }
  return { headers, route: undefined };
}

const proxyRoutes = routes.filter((route) => route.dest?.startsWith("https://"));
/**
 * The backend origin both proxy routes point at: the shipped placeholder until a deploy sets the
 * real one (agents.md §12.7), so the checks below hold for any https origin without a path.
 */
const backendOrigin = new URL(proxyRoutes[0]?.dest ?? "https://invalid.example").origin;

describe("document shell", () => {
  it("uses the PRD site copy as the description", () => {
    expect(html).toContain(`<meta name="description" content="${COPY.siteDefault}" />`);
    expect(html).toContain("<title>Shade</title>");
  });

  it("loads nothing from third parties", () => {
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("keeps capability pages out of search and referrers", () => {
    expect(robots).toMatch(/Disallow: \/pay\//);
    expect(robots).toMatch(/Disallow: \/view/);
    expect(robots).toMatch(/Disallow: \/desk/);
  });
});

describe("vercel.json routes", () => {
  it("uses only the legacy routes array, which Vercel refuses next to rewrites, headers or redirects", () => {
    for (const key of ["rewrites", "headers", "redirects", "cleanUrls", "trailingSlash"]) {
      expect(vercel).not.toHaveProperty(key);
    }
    expect(vercel).toMatchObject({
      framework: "vite",
      buildCommand: "npm run build",
      outputDirectory: "dist",
    });
  });

  it("sends the edge secret from the project variable on both proxy routes, never a literal", () => {
    expect(backendOrigin).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    expect(proxyRoutes.map((route) => [route.src, route.dest])).toEqual([
      ["/api/(.*)", `${backendOrigin}/api/$1`],
      ["/v1/(.*)", `${backendOrigin}/v1/$1`],
    ]);
    for (const route of proxyRoutes) {
      expect(route.continue).toBeUndefined();
      expect(route.transforms).toEqual([
        {
          type: "request.headers",
          op: "set",
          target: { key: "x-shade-edge" },
          args: "$SHADE_EDGE_SECRET",
          env: ["SHADE_EDGE_SECRET"],
        },
      ]);
    }
    // The only value ever given for x-shade-edge is the variable reference.
    const values = [...vercelRaw.matchAll(/"args":\s*"([^"]*)"/g)].map((match) => match[1]);
    expect(values).toEqual(["$SHADE_EDGE_SECRET", "$SHADE_EDGE_SECRET"]);
    expect(vercelRaw.match(/x-shade-edge/gi)).toHaveLength(2);
    for (const route of routes) {
      expect(Object.keys(route.headers ?? {}).map((key) => key.toLowerCase())).not.toContain(
        "x-shade-edge",
      );
    }
  });

  it("proxies the API before the filesystem, and falls back to the SPA after it", () => {
    const filesystem = routes.findIndex((route) => route.handle === "filesystem");
    const fallback = routes.findIndex((route) => route.src === "/(.*)" && route.dest);
    expect(filesystem).toBeGreaterThan(-1);
    expect(routes[fallback]).toEqual({ src: "/(.*)", dest: "/index.html" });
    expect(fallback).toBe(routes.length - 1);
    expect(filesystem).toBeLessThan(fallback);
    for (const route of proxyRoutes) expect(routes.indexOf(route)).toBeLessThan(filesystem);
    // Header routes come first and never end the walk.
    const headerRoutes = routes.filter((route) => route.headers);
    expect(headerRoutes.every((route) => route.continue === true && !route.dest)).toBe(true);
    expect(Math.max(...headerRoutes.map((route) => routes.indexOf(route)))).toBeLessThan(
      Math.min(...proxyRoutes.map((route) => routes.indexOf(route))),
    );

    expect(resolve("/api/desk/me").route?.dest).toBe(`${backendOrigin}/api/$1`);
    expect(resolve("/v1/invoices").route?.dest).toBe(`${backendOrigin}/v1/$1`);
    expect(resolve("/pay/inv_1").route?.dest).toBe("/index.html");
    expect(resolve("/desk/settings/address").route?.dest).toBe("/index.html");
    expect(resolve("/assets/index-abc.js", true).route?.handle).toBe("filesystem");
    // A missing build asset must 404, never fall back to index.html under the immutable cache header.
    expect(resolve("/assets/missing-abc.js").route?.status).toBe(404);
  });

  it("gives every path the security headers", () => {
    for (const path of ["/", "/pay/inv_1", "/view", "/desk", "/docs", "/api/config", "/v1/x"]) {
      const { headers } = resolve(path);
      expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
      expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["X-Frame-Options"]).toBe("DENY");
      expect(headers["Permissions-Policy"]).toContain("camera=()");
      expect(headers["Referrer-Policy"]).toBeDefined();
    }
    expect(resolve("/").headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(resolve("/").headers["X-Robots-Tag"]).toBeUndefined();
  });

  it("sends /pay and /view links without a referrer and keeps them out of search", () => {
    for (const path of ["/pay/inv_1", "/view"]) {
      const { headers } = resolve(path);
      // The capability route comes after the all-paths route, so its Referrer-Policy wins.
      expect(headers["Referrer-Policy"]).toBe("no-referrer");
      expect(headers["X-Robots-Tag"]).toBe("noindex, nofollow");
    }
    // /view is exact: the grant token lives in the fragment, which never reaches the server.
    expect(resolve("/viewer").headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("keeps the desk out of search and caches hashed assets for good", () => {
    for (const path of ["/desk", "/desk/settings/address"]) {
      const { headers } = resolve(path);
      expect(headers["X-Robots-Tag"]).toBe("noindex, nofollow");
      expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    }
    expect(resolve("/assets/index-abc.js", true).headers["Cache-Control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(resolve("/index.html", true).headers["Cache-Control"]).toBeUndefined();
  });
});

describe(".vercelignore (the Vercel CLI uploads the working tree and ignores .gitignore)", () => {
  const rules = vercelIgnore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  it("starts from nothing and re-includes only what the frontend build needs", () => {
    expect(rules[0]).toBe("/*");
    expect(rules.filter((rule) => rule.startsWith("!"))).toEqual([
      "!/package.json",
      "!/package-lock.json",
      "!/tsconfig.base.json",
      "!/frontend",
      "!/backend",
      "!/backend/package.json",
      "!/backend/tsconfig.json",
      "!/backend/sdk",
      "!/backend/sdk/package.json",
      "!/backend/src",
      "!/backend/src/contract",
    ]);
  });

  it("never uploads env files, the dev database or dependencies, wherever they sit", () => {
    for (const rule of ["**/.env", "**/.env.*", "**/*.env", "**/.data", "**/node_modules"]) {
      expect(rules).toContain(rule);
    }
    // Excludes come last, so no later re-include can bring a secret back.
    const lastInclude = rules.findLastIndex((rule) => rule.startsWith("!"));
    expect(rules.indexOf("**/.env")).toBeGreaterThan(lastInclude);
  });
});
