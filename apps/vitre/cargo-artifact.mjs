/** Split Cargo flags from arguments forwarded to the application. */
export function splitRunArguments(args) {
  const separator = args.indexOf("--");
  return separator < 0
    ? { cargo: args, app: [] }
    : { cargo: args.slice(0, separator), app: args.slice(separator + 1) };
}

/** Use Cargo's reported artifact, including custom profiles and target directories. */
export function vitreExecutable(output, reportDiagnostic = () => {}) {
  let executable;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.reason === "compiler-message" && message.message?.rendered) {
      reportDiagnostic(message.message.rendered);
    }
    if (
      message.reason === "compiler-artifact" &&
      message.target?.name === "vitre" &&
      message.target.kind.includes("bin") &&
      message.executable
    ) {
      executable = message.executable;
    }
  }
  if (!executable) throw new Error("Cargo did not report a Vitre executable");
  return executable;
}
