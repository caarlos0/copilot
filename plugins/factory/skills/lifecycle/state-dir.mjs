import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// The new directory wins when it exists. Factories created before the rename
// keep working in place in the legacy directory, which is never moved.
export function stateDirectory(home = homedir()) {
  const current = join(home, ".local/state/copilot-factory");
  const legacy = join(home, ".local/state/copilot-coordinator");
  return !isDirectory(current) && isDirectory(legacy) ? legacy : current;
}
