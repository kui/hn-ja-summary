#!/usr/bin/env node
import { format, type FormatOptionsWithLanguage } from "sql-formatter";
import { readFileSync, writeFileSync } from "node:fs";

const args: string[] = process.argv.slice(2);
const checkMode: boolean = args.includes("--check");
const files: string[] = args.filter((a) => !a.startsWith("-"));

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
  const formatted: string = format(original, formatOptions);
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
