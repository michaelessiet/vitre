import type { CloudCommand, CloudSavedResult, CloudTask } from "@t3tools/contracts/cloud";

export function publicationUnavailable(task: CloudTask, canPrepare: boolean) {
  if (task.source?.kind === "local" || task.repository.installationId === "local")
    return "This workspace is not connected to a GitHub repository.";
  if (task.repository.installationId === "public")
    return "Connect this repository to your personal GitHub account in Vitre on your computer before creating a pull request.";
  if (task.state === "completed" && task.result) return null;
  if (task.publicationPreparation) return null;
  if (!canPrepare) return "Update the cloud service to prepare pull requests from this workspace.";
  if (task.state !== "running" || !task.idle || task.worker?.state !== "ready")
    return ["queued", "preparing", "running", "waiting_for_input"].includes(task.state)
      ? "Wait for the current work to finish before creating a pull request."
      : "Resume this workspace before preparing a pull request.";
  return null;
}

export function reviewedPublication(
  task: CloudTask,
  saved: CloudSavedResult | null,
  title: string,
  body: string,
  idempotencyKey: string,
): Extract<CloudCommand, { type: "publication.create" }> {
  if (
    task.state !== "completed" ||
    !task.result ||
    !saved?.revision ||
    task.result.id !== saved.revision.id ||
    task.result.sha256 !== saved.revision.sha256 ||
    task.checkpoint?.id !== saved.revision.checkpointId ||
    task.checkpoint.sha256 !== saved.revision.sha256
  )
    throw new Error(
      "The saved changes have changed. Review the latest snapshot before publishing.",
    );
  if (!saved.result.diff.trim())
    throw new Error("There are no changes to include in a pull request.");
  if (!title.trim() || !body.trim()) throw new Error("Enter a title and description.");
  return {
    type: "publication.create",
    idempotencyKey,
    taskId: task.id,
    resultId: saved.revision.id,
    resultSha256: saved.revision.sha256,
    kind: "pull_request",
    title: title.trim(),
    body: body.trim(),
  };
}
