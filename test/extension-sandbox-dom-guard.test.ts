import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// 2026-08-25 prod incident: the customer-account extension sandbox's remote-DOM
// elements implement setAttribute/removeAttribute but NOT toggleAttribute. A
// toggleAttribute call crashed the reschedule action modal for every customer,
// and the unit suites could not catch it because jsdom DOES implement it. This
// guard keeps the API out of every extension source file for good — use a
// setAttribute/removeAttribute pair (see setBooleanAttribute in
// extensions/delivery-reschedule-customer/src/order-action-modal.tsx) instead.
const BANNED_DOM_APIS = ["toggleAttribute"];

const EXTENSIONS_ROOT = join(__dirname, "..", "extensions");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") {
        continue;
      }
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (SOURCE_EXTENSIONS.some((suffix) => entry.endsWith(suffix))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("extension sandbox DOM API guard", () => {
  it("no extension source uses a DOM API the sandbox does not implement", () => {
    const srcDirs = readdirSync(EXTENSIONS_ROOT)
      .map((entry) => join(EXTENSIONS_ROOT, entry, "src"))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory();
        } catch {
          return false;
        }
      });

    const offenders: string[] = [];
    for (const dir of srcDirs) {
      for (const file of collectSourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        for (const api of BANNED_DOM_APIS) {
          if (source.includes(api)) {
            offenders.push(`${file}: ${api}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
