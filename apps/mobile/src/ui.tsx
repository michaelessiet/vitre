import { Ionicons } from "@expo/vector-icons";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ComponentProps, ReactNode } from "react";
import { useReducedMotion } from "./motion";

export const colors = {
  background: "#272727",
  surface: "#353535",
  input: "#161616",
  border: "#424242",
  text: "#f1f1f1",
  muted: "#a0a0a0",
  dim: "#777777",
  blue: "#195cff",
  cyan: "#6cd7ff",
  green: "#00c998",
  red: "#ff6573",
};
export function Icon({
  name,
  size = 21,
  color = colors.text,
}: {
  name: ComponentProps<typeof Ionicons>["name"];
  size?: number;
  color?: string;
}) {
  return <Ionicons name={name} size={size} color={color} />;
}
export function IconButton({
  label,
  name,
  onPress,
  disabled = false,
}: {
  label: string;
  name: ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, { opacity: disabled ? 0.35 : pressed ? 0.6 : 1 }]}
    >
      <Icon name={name} />
    </Pressable>
  );
}
export function Button({
  children,
  onPress,
  disabled,
  primary,
  style,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary && { backgroundColor: colors.blue, borderColor: colors.blue },
        { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        style,
      ]}
    >
      <Text style={styles.buttonText}>{children}</Text>
    </Pressable>
  );
}
export function Sheet({
  title,
  children,
  onClose,
  scroll = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  scroll?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <Modal
      animationType={reducedMotion ? "none" : "slide"}
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.sheetHeader}>
          <Text accessibilityRole="header" style={styles.heading}>
            {title}
          </Text>
          <IconButton name="close" label="Close" onPress={onClose} />
        </View>
        {scroll ? (
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
            {children}
          </ScrollView>
        ) : (
          children
        )}
      </SafeAreaView>
    </Modal>
  );
}
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  text: { fontSize: 16, color: colors.text, lineHeight: 24 },
  muted: { fontSize: 13, color: colors.muted, lineHeight: 20 },
  label: { fontSize: 13, color: colors.muted, marginBottom: 8, marginTop: 18 },
  heading: { fontSize: 20, fontWeight: "600", color: colors.text },
  input: {
    backgroundColor: colors.input,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: colors.text,
    minHeight: 48,
  },
  button: {
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: "500" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  sheetHeader: {
    paddingLeft: 20,
    paddingRight: 10,
    minHeight: 62,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sheetBody: { padding: 20, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: colors.surface, borderRadius: 13, padding: 16, gap: 8 },
  error: { color: "#ffb5b9", fontSize: 14, lineHeight: 21 },
});
