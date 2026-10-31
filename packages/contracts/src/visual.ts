import * as Schema from "effect/Schema";
const Label = Schema.String.check(Schema.isMaxLength(200));
export const VisualPoint = Schema.Struct({
  label: Label,
  value: Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: -1e12, maximum: 1e12 }),
  ),
});
export const VisualView = Schema.Struct({
  label: Label,
  kind: Schema.Literals(["bar", "line", "metrics", "table", "flow"]),
  points: Schema.optional(Schema.Array(VisualPoint).check(Schema.isMaxLength(64))),
  columns: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(8))),
  rows: Schema.optional(
    Schema.Array(Schema.Array(Label).check(Schema.isMaxLength(8))).check(Schema.isMaxLength(64)),
  ),
  steps: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(32))),
});
export const VisualSpec = Schema.Struct({
  version: Schema.Literal(1),
  title: Label,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  metrics: Schema.optional(Schema.Array(VisualPoint).check(Schema.isMaxLength(8))),
  views: Schema.Array(VisualView).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type VisualSpec = typeof VisualSpec.Type;
export type VisualView = typeof VisualView.Type;
