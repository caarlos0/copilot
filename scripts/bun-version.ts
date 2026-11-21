// Bundles from another Bun version differ, so the build needs the pinned one.
export function bunVersionError(installed: string, pinned: string): string | undefined {
  if (installed === pinned) return undefined;
  return `Bun ${installed} is installed. This repo needs Bun ${pinned}. Bundles from another version differ.`;
}
