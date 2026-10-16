import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CloudHttpError, CloudUnavailable } from "./api.ts";
import { CloudError } from "./policy.ts";

const encodeConflict = Schema.encodeSync(CloudHttpError);
const encodeUnavailable = Schema.encodeSync(CloudUnavailable);
const decodeUnavailable = Schema.decodeUnknownSync(CloudUnavailable);

describe("command delivery error disposition", () => {
  it("does not infer rejection from a state error or database timeout", () => {
    expect(new CloudError("worker_busy", "A turn is active").requestDisposition).toBe("unknown");
    const unavailable = new CloudError("persistence_unavailable", "Unavailable", 503);
    expect(unavailable.requestDisposition).toBe("unknown");
    expect(unavailable.retryable).toBe(true);
  });
  it("identifies an immutable request-key/payload mismatch as rejected", () => {
    const conflict = new CloudError("idempotency_conflict", "Key was used for another request");
    expect(conflict.requestDisposition).toBe("rejected");
    expect(conflict.retryable).toBe(false);
    expect(encodeConflict(new CloudHttpError(conflict))).toMatchObject({
      code: "idempotency_conflict",
      requestDisposition: "rejected",
      retryable: false,
    });
  });
  it("preserves error metadata on the wire and accepts legacy responses", () => {
    const error = new CloudError("persistence_unavailable", "Unavailable", 503);
    const wire = encodeUnavailable(new CloudUnavailable(error));
    expect(wire).toMatchObject({
      code: error.code,
      requestDisposition: "unknown",
      retryable: true,
    });
    expect(
      decodeUnavailable({
        _tag: "CloudUnavailable",
        code: error.code,
        message: error.message,
      }).requestDisposition,
    ).toBeUndefined();
  });
});
