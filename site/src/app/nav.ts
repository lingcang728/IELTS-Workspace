/**
 * Tiny hash router — Cloudflare Pages serves a static bundle, so routes live
 * behind `#/` with no server rewrites. `#/` or empty hash is the marketing
 * landing page; `#/app/**` is the workspace.
 */
import { useEffect, useState } from "react";

export interface Route {
  /** e.g. "/", "/app", "/app/library", "/app/exam" */
  path: string;
  /** path segments after splitting */
  segments: string[];
  query: URLSearchParams;
  /** in the workspace area */
  isApp: boolean;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = raw.split("?");
  const path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return {
    path: clean,
    segments: clean.split("/").filter(Boolean),
    query: new URLSearchParams(queryPart ?? ""),
    isApp: clean === "/app" || clean.startsWith("/app/"),
  };
}

export function currentRoute(): Route {
  return parseHash(window.location.hash);
}

export function navigate(path: string, query?: Record<string, string | undefined>) {
  const qs = query
    ? "?" +
      Object.entries(query)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
        .join("&")
    : "";
  window.location.hash = `${path}${qs}`;
}

export function href(path: string, query?: Record<string, string | undefined>): string {
  const qs = query
    ? "?" +
      Object.entries(query)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
        .join("&")
    : "";
  return `#${path}${qs}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
