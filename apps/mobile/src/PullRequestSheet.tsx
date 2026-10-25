import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { CloudSavedResult, CloudTask } from "@t3tools/contracts/cloud";
import type { MobileCloud } from "./useCloud";
import { cloudOwned } from "./cloudState";
import { publicationUnavailable, reviewedPublication } from "./publication";
import { Button, colors, Sheet, styles } from "./ui";

export function PullRequestSheet({
  cloud,
  task,
  onClose,
}: {
  cloud: MobileCloud;
  task: CloudTask;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title ?? task.prompt.slice(0, 100));
  const [body, setBody] = useState("Changes prepared in Vitre Cloud.");
  const [saved, setSaved] = useState<CloudSavedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const prepareKey = useRef({ turn: task.turnRequestId, key: Crypto.randomUUID() });
  const publishKey = useRef(Crypto.randomUUID());
  const owned = cloudOwned(cloud.overview, task);
  const unavailable = !owned
    ? "This conversation has moved to another workspace."
    : publicationUnavailable(task, cloud.overview?.capabilities?.publicationPreparation === true);
  const revision = task.state === "completed" ? task.result : null;
  const reviewed =
    !!revision && saved?.revision?.id === revision.id && saved.revision.sha256 === revision.sha256;
  useEffect(() => {
    if (!revision || !cloud.online) return;
    let cancelled = false;
    setSaved(null);
    setError(null);
    publishKey.current = Crypto.randomUUID();
    void cloud.client
      .result(task.id)
      .then((next) => {
        if (cancelled) return;
        if (next.revision?.id !== revision.id || next.revision.sha256 !== revision.sha256)
          throw new Error("The saved changes have changed. Refresh the review.");
        setSaved(next);
      })
      .catch((failure) => {
        if (!cancelled)
          setError(failure instanceof Error ? failure.message : "Could not load saved changes.");
      });
    return () => {
      cancelled = true;
    };
  }, [cloud.client, cloud.online, task.id, revision?.id, revision?.sha256, loadAttempt]);
  const prepare = async () => {
    setSubmitting(true);
    setError(null);
    if (prepareKey.current.turn !== task.turnRequestId)
      prepareKey.current = { turn: task.turnRequestId, key: Crypto.randomUUID() };
    try {
      await cloud.command({
        type: "publication.prepare",
        idempotencyKey: prepareKey.current.key,
        taskId: task.id,
        expectedTurnRequestId: task.turnRequestId ?? null,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save changes for review.");
    } finally {
      setSubmitting(false);
    }
  };
  const publish = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await cloud.command(reviewedPublication(task, saved, title, body, publishKey.current));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not create pull request.");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Sheet title="Create pull request" onClose={onClose}>
      <Text style={styles.muted}>
        {task.repository.owner}/{task.repository.name} · {task.baseBranch}
      </Text>
      {unavailable ? (
        <Text style={styles.error}>{unavailable}</Text>
      ) : task.publicationPreparation ? (
        <View style={[styles.row, { gap: 12 }]}>
          <ActivityIndicator color={colors.blue} />
          <Text accessibilityLiveRegion="polite" style={styles.text}>
            Saving changes for review…
          </Text>
        </View>
      ) : !revision ? (
        <>
          <Text style={styles.text}>
            Save your finished changes, then review and create a draft pull request. Your
            conversation will resume when you send another message.
          </Text>
          <Button
            primary
            disabled={submitting || !cloud.online}
            onPress={() => {
              void prepare();
            }}
          >
            {submitting ? "Saving…" : "Save changes for review"}
          </Button>
        </>
      ) : !reviewed ? (
        <>
          <Text style={styles.muted}>
            {cloud.online ? "Loading saved changes…" : "Reconnect to review saved changes."}
          </Text>
          {error && (
            <Button disabled={!cloud.online} onPress={() => setLoadAttempt((value) => value + 1)}>
              Retry review
            </Button>
          )}
        </>
      ) : (
        <>
          <Text style={styles.label}>Saved changes</Text>
          <ScrollView
            style={{ maxHeight: 230, backgroundColor: colors.input, borderRadius: 12 }}
            nestedScrollEnabled
          >
            <Text
              selectable
              style={{ color: colors.text, padding: 12, fontFamily: "monospace", fontSize: 12 }}
            >
              {saved.result.diff || "No changes to publish."}
            </Text>
          </ScrollView>
          <Text style={styles.muted}>{saved.result.testOutput}</Text>
          <Text style={styles.label}>Title</Text>
          <TextInput
            accessibilityLabel="Pull request title"
            style={styles.input}
            value={title}
            onChangeText={(value) => {
              setTitle(value);
              publishKey.current = Crypto.randomUUID();
            }}
          />
          <Text style={styles.label}>Description</Text>
          <TextInput
            accessibilityLabel="Pull request description"
            style={[styles.input, { minHeight: 110 }]}
            value={body}
            multiline
            onChangeText={(value) => {
              setBody(value);
              publishKey.current = Crypto.randomUUID();
            }}
          />
          <Button
            primary
            disabled={
              submitting ||
              !cloud.online ||
              !title.trim() ||
              !body.trim() ||
              !saved.result.diff.trim()
            }
            onPress={() => {
              void publish();
            }}
          >
            {submitting ? "Creating…" : "Create draft PR"}
          </Button>
        </>
      )}
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </Sheet>
  );
}
