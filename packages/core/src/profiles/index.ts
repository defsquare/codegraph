import type { Profile } from "../profile.js";

import { clojureProfile } from "./clojure.js";
import { csharpProfile } from "./csharp.js";
import { goProfile } from "./go.js";
import { javaProfile } from "./java.js";
import { javascriptProfile } from "./javascript.js";
import { phpProfile } from "./php.js";
import { pythonProfile } from "./python.js";
import { rustProfile } from "./rust.js";
import { typescriptProfile } from "./typescript.js";

export {
  clojureProfile,
  csharpProfile,
  goProfile,
  javaProfile,
  javascriptProfile,
  phpProfile,
  pythonProfile,
  rustProfile,
  typescriptProfile,
};

const ALL_PROFILES: readonly Profile[] = [
  clojureProfile,
  csharpProfile,
  goProfile,
  javaProfile,
  javascriptProfile,
  phpProfile,
  pythonProfile,
  rustProfile,
  typescriptProfile,
];

/**
 * The nine profiles keyed by `lang` — the same prefix an EntityId carries.
 * Null-prototype so a lookup of a language named `constructor` or `toString`
 * cannot resolve to an inherited Object member.
 */
export const PROFILES: Readonly<Record<string, Profile>> = Object.freeze(
  ALL_PROFILES.reduce<Record<string, Profile>>(
    (acc, profile) => {
      acc[profile.lang] = profile;
      return acc;
    },
    Object.create(null) as Record<string, Profile>,
  ),
);

/** Resolve the profile a model claims to conform to; unknown langs yield undefined. */
export function getProfile(lang: string): Profile | undefined {
  return Object.hasOwn(PROFILES, lang) ? PROFILES[lang] : undefined;
}
