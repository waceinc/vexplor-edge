/** Types for scripts/bundle-fixes.mjs (used by test/bundle-fixes.test.ts) */
export interface BundleFix {
  file: string;
  find: string;
  replace: (moduleId: string) => string;
  why: string;
}
export declare const BUNDLE_FIXES: BundleFix[];
export declare function bundleFixes(fixes?: BundleFix[]): {
  applied: string[];
  plugin: { name: string; transform(code: string, id: string): { code: string; map: null } | null };
};
