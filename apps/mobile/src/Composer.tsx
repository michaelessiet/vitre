import { useEffect, useRef, useState } from "react";
import { Alert, Animated, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { ProviderOptionSelections, RuntimeMode, ServerConfig } from "@t3tools/contracts";
import type { CloudProvider } from "@t3tools/contracts/cloud";
import { pickAttachments, type LocalAttachment } from "./attachments";
import { Button, colors, Icon, IconButton, Sheet, styles } from "./ui";
import { composerModels, composerModel } from "./models";
import { useReducedMotion } from "./motion";

export interface ComposerSettings {
  provider: CloudProvider;
  model?: string;
  modelOptions: ProviderOptionSelections;
  runtimeMode: RuntimeMode;
  interactionMode: "default" | "plan";
}
export const defaultSettings: ComposerSettings = {
  provider: "codex",
  modelOptions: [],
  runtimeMode: "approval-required",
  interactionMode: "default",
};
export function Composer({
  text,
  onText,
  settings,
  onSettings,
  attachments,
  onAttachments,
  config,
  onSend,
  busy,
  disabled,
  onStop,
  settingsLocked = false,
  providerLocked = false,
  activeRuntimeMode,
}: {
  text: string;
  onText: (text: string) => void;
  settings: ComposerSettings;
  onSettings: (settings: ComposerSettings) => void;
  attachments: LocalAttachment[];
  onAttachments: (attachments: LocalAttachment[]) => void;
  config: ServerConfig | null;
  onSend: () => void;
  busy?: boolean;
  disabled?: boolean;
  onStop?: () => void;
  settingsLocked?: boolean;
  providerLocked?: boolean;
  activeRuntimeMode?: RuntimeMode;
}) {
  const [options, setOptions] = useState(false);
  const [attach, setAttach] = useState(false);
  const reducedMotion = useReducedMotion();
  const sendScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reducedMotion) {
      sendScale.stopAnimation();
      sendScale.setValue(1);
      return;
    }
    sendScale.setValue(0.85);
    const animation = Animated.spring(sendScale, {
      toValue: 1,
      speed: 20,
      bounciness: 5,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [busy, reducedMotion, sendScale]);
  const pressSend = (pressed: boolean) => {
    if (reducedMotion) return;
    Animated.spring(sendScale, {
      toValue: pressed ? 0.9 : 1,
      speed: 24,
      bounciness: 3,
      useNativeDriver: true,
    }).start();
  };
  const models = composerModels(config, settings.provider);
  const model = composerModel(models, settings.model);
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  const reasoning = settings.modelOptions.find((option) => /reason|effort/i.test(option.id));
  const reasoningDescriptor = descriptors.find((descriptor) => descriptor.id === reasoning?.id);
  const reasoningLabel =
    reasoningDescriptor?.type === "select"
      ? reasoningDescriptor.options.find((option) => option.id === reasoning?.value)?.label
      : undefined;
  const pick = async (images: boolean) => {
    setAttach(false);
    try {
      const files = await pickAttachments(images);
      if (
        files.length + attachments.length > 8 ||
        files.some((file) => file.size > 10 * 1024 * 1024)
      )
        throw new Error("Attach up to 8 files, each at most 10 MiB.");
      onAttachments([...attachments, ...files]);
    } catch (error) {
      Alert.alert(
        "Attachment unavailable",
        error instanceof Error ? error.message : "Try choosing the file again.",
      );
    }
  };
  return (
    <>
      <View
        style={{
          borderWidth: 1,
          borderColor: colors.blue,
          borderRadius: 18,
          backgroundColor: colors.input,
          padding: 8,
        }}
      >
        {!!attachments.length && (
          <ScrollView horizontal contentContainerStyle={{ gap: 6, padding: 6 }}>
            {attachments.map((file) => (
              <Pressable
                key={file.id}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${file.name}`}
                onPress={() => onAttachments(attachments.filter((entry) => entry.id !== file.id))}
                style={[
                  styles.row,
                  { padding: 8, backgroundColor: colors.surface, borderRadius: 8 },
                ]}
              >
                <Icon
                  name={file.type === "image" ? "image-outline" : "document-outline"}
                  size={16}
                />
                <Text style={styles.muted} numberOfLines={1}>
                  {file.name}
                </Text>
                <Icon name="close" size={14} />
              </Pressable>
            ))}
          </ScrollView>
        )}
        <TextInput
          accessibilityLabel="Message"
          value={text}
          onChangeText={onText}
          placeholder="Ask Vitre to work on something…"
          placeholderTextColor={colors.dim}
          multiline
          maxLength={120000}
          style={{
            color: colors.text,
            fontSize: 17,
            lineHeight: 24,
            padding: 8,
            minHeight: 57,
            maxHeight: 150,
            textAlignVertical: "top",
          }}
        />
        <View style={[styles.row, { gap: 1 }]}>
          <IconButton name="add" label="Attach files or photos" onPress={() => setAttach(true)} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Model and conversation settings"
            onPress={() => setOptions(true)}
            style={[styles.row, { flex: 1, minHeight: 44, gap: 5 }]}
          >
            <Icon name="ellipse-outline" size={15} />
            <Text numberOfLines={1} style={{ color: colors.text, fontSize: 13, flexShrink: 1 }}>
              {model?.shortName ?? model?.name ?? settings.model ?? "Cloud default"}
            </Text>
            <Icon name="flash-outline" size={16} />
            <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, flexShrink: 1 }}>
              {reasoning
                ? (reasoningLabel ?? String(reasoning.value))
                : settings.interactionMode === "plan"
                  ? "Plan"
                  : "Reasoning"}
            </Text>
          </Pressable>
          <Animated.View style={{ transform: [{ scale: sendScale }] }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy && onStop ? "Stop work" : "Send message"}
              disabled={disabled || (!busy && !text.trim())}
              onPress={busy && onStop ? onStop : onSend}
              onPressIn={() => pressSend(true)}
              onPressOut={() => pressSend(false)}
              style={{
                width: 38,
                height: 38,
                borderRadius: 22,
                backgroundColor: colors.blue,
                alignItems: "center",
                justifyContent: "center",
                opacity: disabled ? 0.4 : 1,
              }}
            >
              <Icon name={busy && onStop ? "stop" : "arrow-up"} size={23} />
            </Pressable>
          </Animated.View>
        </View>
      </View>
      {attach && (
        <Sheet title="Attach to conversation" onClose={() => setAttach(false)}>
          <Button
            onPress={() => {
              void pick(true);
            }}
          >
            Photos
          </Button>
          <Button
            onPress={() => {
              void pick(false);
            }}
          >
            Choose files
          </Button>
          <Text style={styles.muted}>Up to 8 attachments, 10 MiB each.</Text>
        </Sheet>
      )}
      {options && (
        <Sheet title="Conversation settings" onClose={() => setOptions(false)}>
          {settingsLocked && (
            <Text style={styles.muted}>
              Upgrade the cloud deployment to change settings for follow-up messages.
            </Text>
          )}
          <Text style={styles.label}>Provider</Text>
          <View style={styles.row}>
            {(["codex", "claude"] as const).map((provider) => (
              <Button
                key={provider}
                disabled={settingsLocked || providerLocked}
                primary={settings.provider === provider}
                onPress={() =>
                  onSettings({ ...settings, provider, model: undefined, modelOptions: [] })
                }
              >
                {provider === "codex" ? "Codex" : "Claude"}
              </Button>
            ))}
          </View>
          <Text style={styles.label}>Model</Text>
          {!providerLocked && (
            <Button
              disabled={settingsLocked}
              primary={!settings.model}
              onPress={() => onSettings({ ...settings, model: undefined, modelOptions: [] })}
            >
              Cloud default
            </Button>
          )}
          {models.map((model) => (
            <Button
              key={model.slug}
              disabled={settingsLocked}
              primary={settings.model === model.slug}
              onPress={() => onSettings({ ...settings, model: model.slug, modelOptions: [] })}
            >
              {model.name}
            </Button>
          ))}
          {!config && (
            <Text style={styles.muted}>
              Built-in models are available now. Choices refresh when a cloud conversation connects.
            </Text>
          )}
          {!settings.model && (
            <Text style={styles.muted}>
              Choose a model to set its reasoning level. Cloud default uses the deployment’s model
              settings.
            </Text>
          )}
          {descriptors.map((descriptor) => (
            <View key={descriptor.id}>
              <Text style={styles.label}>{descriptor.label}</Text>
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                {(descriptor.type === "select"
                  ? descriptor.options.map((option) => ({
                      value: option.id as string | boolean,
                      label: option.label,
                    }))
                  : [
                      { value: true, label: "On" },
                      { value: false, label: "Off" },
                    ]
                ).map((option) => (
                  <Button
                    key={String(option.value)}
                    disabled={settingsLocked}
                    primary={
                      settings.modelOptions.find((selection) => selection.id === descriptor.id)
                        ?.value === option.value
                    }
                    onPress={() =>
                      onSettings({
                        ...settings,
                        modelOptions: [
                          ...settings.modelOptions.filter(
                            (selection) => selection.id !== descriptor.id,
                          ),
                          { id: descriptor.id, value: option.value },
                        ],
                      })
                    }
                  >
                    {option.label}
                  </Button>
                ))}
              </View>
            </View>
          ))}
          <Text style={styles.label}>Permissions for your next message</Text>
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            {(
              [
                ["approval-required", "Ask first"],
                ["auto-accept-edits", "Allow edits"],
                ["full-access", "Full access"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                disabled={settingsLocked}
                primary={settings.runtimeMode === value}
                onPress={() => onSettings({ ...settings, runtimeMode: value })}
              >
                {label}
              </Button>
            ))}
          </View>
          {activeRuntimeMode && activeRuntimeMode !== settings.runtimeMode && (
            <Text style={styles.muted}>
              This turn uses{" "}
              {
                {
                  auto: "Automatic",
                  "approval-required": "Ask first",
                  "auto-accept-edits": "Allow edits",
                  "full-access": "Full access",
                }[activeRuntimeMode]
              }
              . Your selection applies to your next message. Any pending approval still needs a
              response.
            </Text>
          )}
          <Text style={styles.label}>Interaction</Text>
          <View style={styles.row}>
            {(["default", "plan"] as const).map((value) => (
              <Button
                key={value}
                disabled={settingsLocked}
                primary={settings.interactionMode === value}
                onPress={() => onSettings({ ...settings, interactionMode: value })}
              >
                {value === "plan" ? "Plan" : "Work"}
              </Button>
            ))}
          </View>
          <Button onPress={() => setOptions(false)}>Done</Button>
        </Sheet>
      )}
    </>
  );
}
