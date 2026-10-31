import { describe, expect, it, vi } from "vite-plus/test";
import {
  measureSize,
  sizeLabel,
  sumNumstat,
  syncDefinitions,
  syncSizeLabel,
  type Label,
} from "./labels.ts";

const labels: Label[] = [
  { name: "size:S", color: "5ebd3e", description: "Small" },
  { name: "size:M", color: "fbca04", description: "Medium" },
];

describe("PR size", () => {
  it.each([
    [0, "XS"],
    [9, "XS"],
    [10, "S"],
    [29, "S"],
    [30, "M"],
    [99, "M"],
    [100, "L"],
    [499, "L"],
    [500, "XL"],
    [999, "XL"],
    [1000, "XXL"],
  ] as const)("classifies %i lines as %s", (lines, size) => {
    expect(sizeLabel(lines)).toBe(`size:${size}`);
  });
  it("ignores binary files and counts additions and deletions", () => {
    expect(sumNumstat("-\t-\timage.png\n10\t4\tcode.ts\n")).toBe(14);
    expect(sumNumstat("")).toBe(0);
  });
  it("excludes test lines in mixed PRs and counts them in test-only PRs", () => {
    const mixed = vi
      .fn()
      .mockReturnValueOnce("100\t20\tall\n")
      .mockReturnValueOnce("10\t1\tcode\n");
    expect(measureSize("base", "head", mixed)).toEqual({
      all: 120,
      nonTest: 11,
      effective: 11,
      label: "size:S",
    });
    expect(mixed.mock.calls[1]![0]).toContain(":(glob,exclude)**/*.test.*");
    expect(mixed.mock.calls[0]![0]).toContain("--no-textconv");
    const onlyTests = vi.fn().mockReturnValueOnce("100\t20\ttests\n").mockReturnValueOnce("");
    expect(measureSize("base", "head", onlyTests).label).toBe("size:L");
  });
});

describe("label synchronization", () => {
  it("creates missing definitions", async () => {
    const request = vi.fn().mockRejectedValueOnce({ status: 404 }).mockResolvedValueOnce({});
    await syncDefinitions({ request }, "owner/repo", [labels[0]!]);
    expect(request).toHaveBeenLastCalledWith("POST", "/repos/owner/repo/labels", labels[0]);
  });
  it("updates stale definitions and leaves matching ones untouched", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...labels[0], color: "000000" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(labels[1]);
    await syncDefinitions({ request }, "owner/repo", labels);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]![0]).toBe("PATCH");
  });
  it("reconciles a concurrent create and propagates permission errors", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce({ status: 404 })
      .mockRejectedValueOnce({ status: 422 })
      .mockResolvedValueOnce(labels[0]);
    await syncDefinitions({ request }, "owner/repo", [labels[0]!]);
    expect(request).toHaveBeenCalledTimes(3);
    await expect(
      syncDefinitions(
        { request: vi.fn().mockRejectedValue({ status: 403 }) },
        "owner/repo",
        labels,
      ),
    ).rejects.toEqual({ status: 403 });
  });
  it("replaces only managed size labels and preserves unrelated labels", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce([{ name: "bug" }, { name: "size:M" }])
      .mockResolvedValue({});
    await syncSizeLabel({ request }, "owner/repo", 42, "size:S", labels);
    expect(request.mock.calls[1]).toEqual([
      "DELETE",
      "/repos/owner/repo/issues/42/labels/size%3AM",
    ]);
    expect(request.mock.calls[2]).toEqual([
      "POST",
      "/repos/owner/repo/issues/42/labels",
      { labels: ["size:S"] },
    ]);
  });
  it("is idempotent when the right label is already present", async () => {
    const request = vi.fn().mockResolvedValue([{ name: "size:S" }]);
    await syncSizeLabel({ request }, "owner/repo", 42, "size:S", labels);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
