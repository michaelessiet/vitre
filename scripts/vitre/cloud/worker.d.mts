export interface PreparationUpdate {
  phase?: string;
  outcome?: string;
  detail?: string;
}

export function createPreparationReporter(
  publish: (progress: PreparationUpdate) => Promise<unknown>,
): {
  report(update: PreparationUpdate): void;
  flush(): Promise<void>;
};
