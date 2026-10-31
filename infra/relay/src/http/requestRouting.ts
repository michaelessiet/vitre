export function requestRouteFamily(url: string): "documentation" | "cloud" | "relay" {
  const path = new URL(url, "https://relay.invalid").pathname;
  if (["/", "/account/github", "/docs", "/openapi.json", "/v1/cloud/openapi.json"].includes(path)) {
    return "documentation";
  }
  return path === "/v1/cloud" || path.startsWith("/v1/cloud/") ? "cloud" : "relay";
}
