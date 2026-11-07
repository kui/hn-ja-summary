#!/usr/bin/env node
import { format, type FormatOptionsWithLanguage } from "sql-formatter";
import { globSync, readFileSync, writeFileSync } from "node:fs";

const args: string[] = process.argv.slice(2);
const checkMode: boolean = args.includes("--check");
// Windows の npm は scripts を cmd で実行しグロブを展開しないため、ここで展開する
const files: string[] = args
  .filter((a) => !a.startsWith("-"))
  .flatMap((pattern) => globSync(pattern))
  .sort();

const formatOptions: FormatOptionsWithLanguage = {
  language: "sqlite",
  tabWidth: 2,
  keywordCase: "upper",
  dataTypeCase: "upper",
  functionCase: "upper",
  logicalOperatorNewline: "before",
  expressionWidth: 60,
};

let hasUnformatted = false;

for (const file of files) {
  const original: string = readFileSync(file, "utf-8");
  const formatted: string = format(original, formatOptions) + "\n";
  if (original !== formatted) {
    if (checkMode) {
      console.error(`not formatted: ${file}`);
      hasUnformatted = true;
    } else {
      writeFileSync(file, formatted, "utf-8");
      console.log(`formatted: ${file}`);
    }
  }
}

if (hasUnformatted) process.exit(1);
