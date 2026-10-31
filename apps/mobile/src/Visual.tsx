/* oxlint-disable react/no-array-index-key -- Visual datasets are immutable and bounded; ordinal positions distinguish duplicate labels. */
import { memo, useMemo, useState } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { parseVisual } from "@t3tools/shared/visual";
import type { VisualView } from "@t3tools/contracts/visual";
import { colors, IconButton, styles } from "./ui";

function Chart({ view }: { view: VisualView }) {
  const points = view.points ?? [];
  const [width, setWidth] = useState(280);
  const [selected, setSelected] = useState<number | null>(null);
  const minimum = Math.min(0, ...points.map((p) => p.value));
  const maximum = Math.max(0, ...points.map((p) => p.value));
  const range = maximum - minimum || 1;
  const x = (i: number) => 36 + (i * (width - 48)) / Math.max(1, points.length - 1);
  const y = (value: number) => 16 + (168 * (maximum - value)) / range;
  if (view.kind === "bar")
    return (
      <View style={{ gap: 10 }}>
        {points.map((point, i) => (
          <Pressable
            key={i}
            accessibilityRole="button"
            accessibilityLabel={`${point.label}: ${point.value}`}
            onPress={() => setSelected(i)}
            style={{ gap: 5 }}
          >
            <View style={[styles.row, { justifyContent: "space-between" }]}>
              <Text style={[styles.muted, { flex: 1 }]}>{point.label}</Text>
              <Text style={styles.text}>{point.value}</Text>
            </View>
            <View style={{ height: 16, backgroundColor: colors.input, borderRadius: 3 }}>
              <View
                style={{
                  position: "absolute",
                  left: `${(100 * (Math.min(0, point.value) - minimum)) / range}%`,
                  width: `${(100 * Math.abs(point.value)) / range}%`,
                  height: 16,
                  borderRadius: 3,
                  backgroundColor: i === selected ? colors.green : colors.cyan,
                }}
              />
              <View
                style={{
                  position: "absolute",
                  left: `${(100 * -minimum) / range}%`,
                  width: 1,
                  height: 16,
                  backgroundColor: colors.muted,
                }}
              />
            </View>
          </Pressable>
        ))}
      </View>
    );
  return (
    <View onLayout={(e) => setWidth(Math.max(80, e.nativeEvent.layout.width))}>
      <View
        accessible
        accessibilityLabel={points.map((point) => `${point.label}: ${point.value}`).join(", ")}
        style={{ height: 220 }}
      >
        {[0, 1, 2, 3, 4].map((tick) => {
          const value = minimum + (range * tick) / 4;
          return (
            <View key={tick} style={{ position: "absolute", left: 0, right: 0, top: y(value) }}>
              <Text
                style={{
                  position: "absolute",
                  left: 0,
                  top: -7,
                  fontSize: 10,
                  color: colors.muted,
                }}
              >
                {Number(value.toPrecision(3))}
              </Text>
              <View style={{ marginLeft: 34, height: 0.5, backgroundColor: colors.border }} />
            </View>
          );
        })}
        {points.slice(1).map((point, i) => {
          const dx = x(i + 1) - x(i),
            dy = y(point.value) - y(points[i]!.value);
          const length = Math.hypot(dx, dy);
          return (
            <View
              key={`line-${i}`}
              style={{
                position: "absolute",
                left: (x(i) + x(i + 1) - length) / 2,
                top: (y(point.value) + y(points[i]!.value)) / 2,
                width: length,
                height: 2,
                backgroundColor: colors.cyan,
                transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
              }}
            />
          );
        })}
        {points.map((point, i) => (
          <Pressable
            key={i}
            accessibilityLabel={`${point.label}: ${point.value}`}
            onPress={() => setSelected(i)}
            hitSlop={10}
            style={{
              position: "absolute",
              left: x(i) - 5,
              top: y(point.value) - 5,
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: selected === i ? colors.green : colors.cyan,
            }}
          />
        ))}
        <Text style={[styles.muted, { position: "absolute", bottom: 0, left: 0 }]}>
          {points[0]?.label}
        </Text>
        <Text style={[styles.muted, { position: "absolute", bottom: 0, right: 0 }]}>
          {points.at(-1)?.label}
        </Text>
      </View>
      <Text style={styles.muted}>
        {selected === null
          ? "Tap a point to inspect its value."
          : `${points[selected]?.label}: ${points[selected]?.value}`}
      </Text>
    </View>
  );
}

export const Visual = memo(function Visual({ source }: { source: string }) {
  const result = useMemo(() => {
    try {
      return { spec: parseVisual(source), error: null };
    } catch {
      return {
        spec: null,
        error: "This visual is incomplete or has unsupported data. View its source for details.",
      };
    }
  }, [source]);
  const [selected, setSelected] = useState(0),
    [showSource, setShowSource] = useState(false),
    [showData, setShowData] = useState(false),
    [copied, setCopied] = useState(false);
  const view = result.spec?.views[Math.min(selected, result.spec.views.length - 1)];
  const options = () => {
    const actions = [
      {
        text: showSource ? "Show visual" : "View source",
        onPress: () => setShowSource(!showSource),
      },
      {
        text: copied ? "Copied" : "Copy source",
        onPress: () => {
          void Clipboard.setStringAsync(source).then(() => setCopied(true));
        },
      },
      {
        text: showData ? "Show chart" : "Show data",
        onPress: () => {
          setShowData(!showData);
          setShowSource(false);
        },
      },
      {
        text: "Reset view",
        onPress: () => {
          setSelected(0);
          setShowSource(false);
          setShowData(false);
          setCopied(false);
        },
      },
    ];
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...actions.map((action) => action.text), "Cancel"],
          cancelButtonIndex: actions.length,
        },
        (index) => actions[index]?.onPress(),
      );
    else Alert.alert("Visualization", undefined, [...actions, { text: "Cancel", style: "cancel" }]);
  };
  return (
    <View style={{ gap: 16, marginVertical: 18 }}>
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Text
          accessibilityRole="header"
          style={[styles.text, { fontSize: 15, fontWeight: "500", flex: 1 }]}
        >
          {result.spec?.title ?? "Visualization"}
        </Text>
        <IconButton name="ellipsis-horizontal" label="Visualization options" onPress={options} />
      </View>
      {showSource ? (
        <Text selectable style={[styles.muted, { fontFamily: "monospace" }]}>
          {source}
        </Text>
      ) : result.error ? (
        <Text style={styles.error}>{result.error}</Text>
      ) : (
        view && (
          <>
            {!!result.spec?.description && (
              <Text style={styles.muted}>{result.spec.description}</Text>
            )}
            {!!result.spec?.metrics?.length && (
              <View
                style={[
                  styles.row,
                  { flexWrap: "wrap", alignItems: "flex-start", gap: 20, paddingVertical: 8 },
                ]}
              >
                {result.spec.metrics.map((metric, i) => (
                  <View key={i} style={{ flex: 1, minWidth: 90, gap: 8 }}>
                    <Text style={styles.muted}>{metric.label}</Text>
                    <Text style={{ fontSize: 30, color: colors.text, fontWeight: "600" }}>
                      {metric.value.toLocaleString()}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            {result.spec!.views.length > 1 && (
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                {result.spec!.views.map((entry, i) => (
                  <Pressable
                    key={i}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: selected === i }}
                    onPress={() => setSelected(i)}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 6,
                      backgroundColor: selected === i ? colors.text : "transparent",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: "500",
                        color: selected === i ? colors.input : colors.muted,
                      }}
                    >
                      {entry.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            {["bar", "line"].includes(view.kind) && (
              <>{!showData && <Chart key={`${selected}:${view.kind}`} view={view} />}</>
            )}
            {view.kind === "metrics" && (
              <View style={[styles.row, { flexWrap: "wrap", alignItems: "flex-start", gap: 20 }]}>
                {view.points?.map((point, i) => (
                  <View key={i} style={{ flex: 1, minWidth: 90, gap: 8 }}>
                    <Text style={styles.muted}>{point.label}</Text>
                    <Text style={{ fontSize: 30, fontWeight: "600", color: colors.text }}>
                      {point.value.toLocaleString()}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            {showData &&
              ["bar", "line"].includes(view.kind) &&
              view.points?.map((point, i) => (
                <View key={i} style={styles.row}>
                  <Text style={[styles.muted, { flex: 1 }]}>{point.label}</Text>
                  <Text style={[styles.text, { fontWeight: "600" }]}>{point.value}</Text>
                </View>
              ))}
            {view.kind === "table" && (
              <ScrollView horizontal>
                <View style={{ gap: 8 }}>
                  {[view.columns!, ...view.rows!].map((row, i) => (
                    <View key={i} style={{ flexDirection: "row", gap: 12 }}>
                      {row.map((cell, j) => (
                        <Text
                          key={j}
                          selectable
                          style={[styles.text, { width: 135, fontWeight: i === 0 ? "600" : "400" }]}
                        >
                          {cell}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            )}
            {view.kind === "flow" &&
              view.steps?.map((step, i) => (
                <View key={i} style={[styles.row, { alignItems: "flex-start" }]}>
                  <Text style={{ color: colors.cyan }}>{i + 1}</Text>
                  <Text style={[styles.text, { flex: 1 }]}>{step}</Text>
                </View>
              ))}
          </>
        )
      )}
    </View>
  );
});
