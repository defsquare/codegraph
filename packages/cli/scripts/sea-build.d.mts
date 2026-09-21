// Types for sea-build.mjs; see sea-config.d.mts for why the script is JavaScript.
export function hostRid(platform?: NodeJS.Platform, arch?: string): string;
export function seaUnsupported(
  variables?: { readonly single_executable_application?: boolean },
  execPath?: string,
): string | undefined;
export function buildSea(options?: { readonly rid?: string; readonly outDir?: string }): Promise<string>;
