/**
 * Migration runner. Forty lines instead of a framework.
 *
 * Applies db/migrations/*.sql in lexical order, once each, recording what ran
 * in schema_migration. Statements inside a file are separated by a line
 * containing only `--> break` — splitting on `;` breaks the moment a migration
 * contains a dollar-quoted function body, and a splitter that is right 95% of
 * the time is worse than an explicit marker.
 *
 * Not transactional across files. Each file is small and idempotent
 * (`create table if not exists`), which is the cheaper guarantee here.
 *
 *   npm run db:migrate
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadServerEnv } from "../lib/capsule/env";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../db/migrations");

async function main() {
  const env = loadServerEnv();
  const sql = neon(env.databaseUrl);

  await sql`
    create table if not exists schema_migration (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Set(
    ((await sql`select name from schema_migration`) as { name: string }[]).map((r) => r.name),
  );

  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    console.log("no migrations found");
    return;
  }

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip   ${file}`);
      continue;
    }

    const statements = readFileSync(resolve(dir, file), "utf8")
      .split(/^--> break\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/.test(s));

    for (const statement of statements) {
      await sql.query(statement);
    }

    await sql`insert into schema_migration (name) values (${file})`;
    console.log(`  apply  ${file} (${statements.length} statement${statements.length === 1 ? "" : "s"})`);
    ran += 1;
  }

  console.log(`\n${ran} applied, ${files.length - ran} already present`);
}

main().catch((error) => {
  console.error(`\nmigration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
