import { expect, it } from "vite-plus/test";
import { makeShowcaseClient } from "./showcase";

it("renders the native acceptance fixture through the real cloud contracts", async () => {
  const client = makeShowcaseClient();
  const overview = await client.overview();
  expect(overview.tasks.length).toBeGreaterThan(1);
  expect((await client.events(overview.tasks[0]!.id)).conversation).not.toBeNull();
});
