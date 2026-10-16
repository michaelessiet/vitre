import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { GitHubConfiguration } from "./github.ts";
import type { CloudError } from "./policy.ts";

import type { MachineConfiguration } from "./compute.ts";

export interface CloudConfigurationValue {
  machine?: MachineConfiguration;
  enabled: boolean;
  allowedUserId: string;
  controlUrl: string;
  encryptionKey: string;
  github: GitHubConfiguration;
  wake: (userId: string) => Effect.Effect<void, CloudError>;
}
export class CloudConfiguration extends Context.Service<
  CloudConfiguration,
  CloudConfigurationValue
>()("t3code-relay/cloud/config/CloudConfiguration") {}
