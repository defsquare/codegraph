// Types for sea-config.mjs — the script stays plain JavaScript because it runs
// on a bare CI runner before anything is compiled; the tests import it typed.
export interface SeaConfig {
  readonly main: string;
  readonly output: string;
  readonly disableExperimentalSEAWarning: boolean;
  readonly useSnapshot: boolean;
  readonly useCodeCache: boolean;
  readonly assets: Readonly<Record<string, string>>;
}

export const CLI_DIR: string;
export const SEA_FUSE: string;
export function filesBelow(root: string): string[];
export function seaConfig(input: {
  readonly main: string;
  readonly output: string;
  readonly packageJson: string;
  readonly frontends: Readonly<Record<string, string>>;
}): SeaConfig;
export function repositorySeaConfig(outDir?: string): SeaConfig;
