/** Resolve file links against the conversation workspace, never the phone's filesystem. */
export function messageLink(url: string, workspaceRoot: string) {
  if (/^https?:\/\//i.test(url)) return { kind: "web" as const, url };
  let path: string;
  try {
    path = decodeURIComponent(url.replace(/[?#].*$/, "")).replace(/:\d+(?::\d+)?$/, "");
  } catch {
    throw new Error("This file link has an invalid path.");
  }
  if (!path || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//"))
    throw new Error("This link type is not supported on mobile.");
  const root = workspaceRoot.replace(/\/+$/, "");
  if (path.startsWith(root + "/")) path = path.slice(root.length + 1);
  if (path.startsWith("/")) throw new Error("This file is outside the conversation workspace.");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) throw new Error("This file is outside the conversation workspace.");
      segments.pop();
    } else segments.push(segment);
  }
  if (!segments.length || path.includes("\0")) throw new Error("This link does not name a file.");
  return { kind: "file" as const, cwd: workspaceRoot, relativePath: segments.join("/") };
}
