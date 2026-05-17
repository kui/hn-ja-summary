import { format } from "sql-formatter";
import { expandGlob } from "@std/fs/expand-glob";

const checkMode = Deno.args.includes("--check");
const pattern = Deno.args.find((a) => !a.startsWith("--")) ?? "**/*.sql";

let hasUnformatted = false;

for await (const entry of expandGlob(pattern)) {
  const original = await Deno.readTextFile(entry.path);
  const formatted = format(original, {
    language: "sqlite",
    tabWidth: 2,
    keywordCase: "upper",
    dataTypeCase: "upper",
    functionCase: "upper",
    logicalOperatorNewline: "before",
    expressionWidth: 60,
  });
  if (original !== formatted) {
    if (checkMode) {
      console.error(`not formatted: ${entry.path}`);
      hasUnformatted = true;
    } else {
      await Deno.writeTextFile(entry.path, formatted);
      console.log(`formatted: ${entry.path}`);
    }
  }
}

if (hasUnformatted) Deno.exit(1);
