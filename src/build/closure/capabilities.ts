import type { LanguageOut } from "../../api/types";
import { resolveViteTargetLanguageOut as resolveNativeViteTargetLanguageOut } from "../../native/load";

const CLOSURE_LANGUAGE_LEVELS: readonly LanguageOut[] = [
  "ECMASCRIPT3",
  "ECMASCRIPT5",
  "ECMASCRIPT6",
  "ECMASCRIPT_2015",
  "ECMASCRIPT_2016",
  "ECMASCRIPT_2017",
  "ECMASCRIPT_2018",
  "ECMASCRIPT_2019",
  "ECMASCRIPT_2020",
  "ECMASCRIPT_2021",
  "STABLE",
  "ECMASCRIPT_NEXT",
];

export function mapViteTargetToLanguageOut(target: string): LanguageOut | null {
  const languageOut = resolveNativeViteTargetLanguageOut(target);
  return CLOSURE_LANGUAGE_LEVELS.find((level) => level === languageOut) ?? null;
}

export function languageOutRank(languageOut: LanguageOut) {
  return CLOSURE_LANGUAGE_LEVELS.indexOf(languageOut);
}
