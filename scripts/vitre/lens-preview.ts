/** Local QA transport; run explicitly. Never forwards requests or credentials. */
import * as NodeHttp from "node:http";
import { makeLensPreview } from "../../packages/shared/src/lensPreview.ts";
import { LensCommand } from "@t3tools/contracts/lens";
import * as Schema from "effect/Schema";
const preview = makeLensPreview();
const decode = Schema.decodeUnknownSync(LensCommand);
NodeHttp.createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 100000) throw new Error("Too large");
    }
    const result =
      request.method === "POST"
        ? await preview.lensCommand(decode(JSON.parse(body)))
        : await preview.lens();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  } catch {
    response.writeHead(400);
    response.end("Invalid preview request");
  }
}).listen(4897, "127.0.0.1", () =>
  console.log("Lens preview: http://127.0.0.1:4897 (sample data only)"),
);
