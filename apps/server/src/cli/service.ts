import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

const removedMessage =
  "The Vitre background service has been removed. Launch the desktop app to run Vitre on this machine.";

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription(removedMessage),
  Command.withHandler(() => Console.log(removedMessage).pipe(Effect.asVoid)),
);
