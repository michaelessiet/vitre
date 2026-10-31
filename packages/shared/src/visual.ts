import { VisualSpec } from "@t3tools/contracts/visual";
import * as Schema from "effect/Schema";
const decode = Schema.decodeUnknownSync(VisualSpec, { onExcessProperty: "error" });
/** Deliberately data-only: no HTML, script, network, or executable expressions. */
export function parseVisual(source: string): VisualSpec {
  if (new TextEncoder().encode(source).length > 65536)
    throw new Error("Visuals must be smaller than 64 KiB.");
  const spec = decode(JSON.parse(source));
  for (const view of spec.views) {
    if (
      view.kind === "table" &&
      (!view.columns?.length ||
        !view.rows ||
        view.rows.some((row) => row.length !== view.columns!.length))
    )
      throw new Error("Table rows must match the columns.");
    if (view.kind === "flow" && !view.steps?.length)
      throw new Error("A flow needs at least one step.");
    if (["bar", "line", "metrics"].includes(view.kind) && !view.points?.length)
      throw new Error("This view needs at least one point.");
  }
  return spec;
}
export const VISUAL_INSTRUCTIONS = `Vitre renders native interactive visuals in assistant messages on desktop and mobile. Use them when a chart, metrics, comparison, table, or flow helps the user understand. Emit a fenced code block with language vitre-visual and a JSON object (never HTML or JavaScript). Format: {"version":1,"title":"Title","description":"Optional context and units","views":[{"label":"Scenario A","kind":"bar","points":[{"label":"A","value":3},{"label":"B","value":5}]}]}. An optional top-level metrics:[{label,value}] (up to 8) shows headline numbers above the chart. Each view is a selectable tab; supported kinds: bar, line, metrics (points); table (columns:string[],rows:string[][]); flow (steps:string[]). At most 8 views, 64 points or rows, 8 columns, 32 steps; labels 200 characters; source 64 KiB. Values must be finite between -1e12 and 1e12. Include units and provenance in the description, preserve negative values, and do not fabricate observations. Users can switch views, inspect data, copy source, and reset locally. Visual controls cannot execute commands or authorize cleanup. Explain key findings in prose too. Use visual_check to validate complicated visuals before including the fenced block in your response.`;
