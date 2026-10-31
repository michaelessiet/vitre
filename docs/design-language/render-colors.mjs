// Generate documentation artwork directly from the native theme tokens.
import * as NodeFSP from "node:fs/promises";

const { themes } = JSON.parse(
  await NodeFSP.readFile(
    new URL("../../crates/vitre-app/themes/vitre.json", import.meta.url),
    "utf8",
  ),
);
const roles = [
  ["background", "Canvas"],
  ["foreground", "Primary text"],
  ["muted.foreground", "Supporting text"],
  ["popover.background", "Floating surface"],
  ["accent.background", "Selection surface"],
  ["border", "Divider"],
  ["primary.background", "Primary action"],
  ["success.background", "Success"],
  ["warning.background", "Warning"],
  ["danger.background", "Error"],
];
const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const panels = ["dark", "light"].map((mode, index) => {
  const theme = themes.find((entry) => entry.mode === mode);
  const colors = theme.colors;
  const x = 24 + index * 550;
  const rows = roles
    .map(([token, label], row) => {
      const y = 132 + row * 53;
      const value = colors[token];
      const fill = value.slice(0, 7);
      const alpha = value.length === 9 ? parseInt(value.slice(7), 16) / 255 : 1;
      return `<rect x="${x + 22}" y="${y}" width="34" height="34" rx="8" fill="${fill}" fill-opacity="${alpha}" stroke="${colors["muted.foreground"]}" stroke-opacity="0.3"/>
      <text x="${x + 70}" y="${y + 14}" fill="${colors.foreground}" font-size="14">${esc(label)}</text>
      <text x="${x + 70}" y="${y + 31}" fill="${colors["muted.foreground"]}" font-size="11">${esc(token)}</text>
      <text x="${x + 505}" y="${y + 23}" text-anchor="end" fill="${colors["muted.foreground"]}" font-family="Menlo, monospace" font-size="12">${value}</text>`;
    })
    .join("\n");
  return `<rect x="${x}" y="74" width="530" height="608" rx="12" fill="${colors.background}" stroke="#888888" stroke-opacity="0.25"/>
    <text x="${x + 22}" y="110" fill="${colors.foreground}" font-size="20" font-weight="600">${esc(theme.name)}</text>${rows}`;
});
await NodeFSP.writeFile(
  new URL("images/colors.svg", import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1128" height="736" viewBox="0 0 1128 736" role="img" aria-labelledby="title description">
  <title id="title">Vitre semantic color tokens</title>
  <desc id="description">Dark and light theme swatches generated from crates/vitre-app/themes/vitre.json. Transparent tokens are composited over each theme's canvas.</desc>
  <rect width="1128" height="736" fill="#eeeef0"/>
  <g font-family="DM Sans, Arial, sans-serif">
  <text x="24" y="44" fill="#27272a" font-size="24" font-weight="600">Vitre / Semantic colors</text>
  ${panels.join("\n")}
  <text x="24" y="714" fill="#52525b" font-size="12">Base tokens · Surface alpha is adjusted by glass.rs · Use cx.theme() in feature code</text>
  </g></svg>\n`,
);
