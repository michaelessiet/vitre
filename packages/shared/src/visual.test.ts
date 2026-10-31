import { expect, it } from "vite-plus/test";
import { parseVisual } from "./visual.ts";
const chart = {
  version: 1,
  title: "Comparison",
  views: [
    {
      label: "Example",
      kind: "bar",
      points: [
        { label: "Loss", value: -4 },
        { label: "Gain", value: 6 },
      ],
    },
  ],
};
it("preserves native chart data, negative values, and scenario tabs", () => {
  expect(parseVisual(JSON.stringify(chart)).views[0]!.points![0]!.value).toBe(-4);
});
it("rejects executable fields, unknown nodes, nonfinite numbers and excessive data", () => {
  for (const value of [
    { ...chart, script: "fetch('/secret')" },
    { ...chart, views: [{ label: "x", kind: "html", html: "<script/>" }] },
    { ...chart, views: [] },
    { ...chart, views: Array(9).fill(chart.views[0]) },
    { ...chart, views: [{ ...chart.views[0], points: [{ label: "x", value: 1e13 }] }] },
  ])
    expect(() => parseVisual(JSON.stringify(value))).toThrow();
  expect(() => parseVisual(" ".repeat(65537))).toThrow();
  expect(() => parseVisual(JSON.stringify(chart).slice(0, -2))).toThrow();
});
it("validates table widths and flow contents", () => {
  expect(() =>
    parseVisual(
      JSON.stringify({
        ...chart,
        views: [{ label: "x", kind: "table", columns: ["One"], rows: [["A", "B"]] }],
      }),
    ),
  ).toThrow();
  expect(
    parseVisual(
      JSON.stringify({
        ...chart,
        views: [{ label: "x", kind: "flow", steps: ["Start", "Finish"] }],
      }),
    ).views[0]!.steps,
  ).toEqual(["Start", "Finish"]);
});

it("validates headline metrics independently from chart data", () => {
  expect(
    parseVisual(JSON.stringify({ ...chart, metrics: [{ label: "Total", value: 3450 }] }))
      .metrics?.[0]?.value,
  ).toBe(3450);
  expect(() =>
    parseVisual(
      JSON.stringify({
        ...chart,
        metrics: Array.from({ length: 9 }, () => ({ label: "Too many", value: 1 })),
      }),
    ),
  ).toThrow();
  expect(() =>
    parseVisual(JSON.stringify({ ...chart, metrics: [{ label: "Huge", value: 1e13 }] })),
  ).toThrow();
});
