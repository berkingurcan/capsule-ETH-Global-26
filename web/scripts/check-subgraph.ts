/**
 * Drift guard for the subgraph query.
 *
 * `lib/capsule/fleet-graph.ts` sends one GraphQL document to the index and maps
 * the answer field by field. `subgraph/schema.graphql` decides what those
 * fields are called. Nothing connects the two — the query is a template
 * literal, the schema is a file in another package, and TypeScript sees
 * neither.
 *
 * Which would be a small problem if it failed loudly. It does not. A renamed
 * entity field makes the query error, `readFleetFromSubgraph` throws a
 * `SubgraphError`, `loadFleet` catches it and falls back to the chain reader,
 * and /fleet keeps rendering a correct fleet. The subgraph silently stops
 * being used and the only evidence is one line in a server log and the words
 * "via eth_getLogs" in the page footer.
 *
 * So: parse both, walk the query against the schema, and refuse to agree that
 * a field exists because it looks like it should.
 *
 * Also checks the two values `subgraph.yaml` pins that must match this app's
 * environment — the minter address and its deploy block. A subgraph indexing a
 * superseded minter answers every query successfully with an empty fleet.
 *
 *   npm run check:subgraph
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  Kind,
  parse,
  type DocumentNode,
  type FieldNode,
  type SelectionSetNode,
  type TypeNode,
} from "graphql";

import { FLEET_QUERY } from "../lib/capsule/fleet-graph";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "../../subgraph/schema.graphql");
const manifestPath = resolve(here, "../../subgraph/subgraph.yaml");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const expect = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

if (!existsSync(schemaPath)) {
  console.error(`✗ ${schemaPath} not found — is the subgraph checked out?`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. The schema, as a field table.
// ---------------------------------------------------------------------------
const schema: DocumentNode = parse(readFileSync(schemaPath, "utf8"));

/** Entity name -> field name -> the entity that field resolves to, or null for a scalar. */
const entities = new Map<string, Map<string, string | null>>();

/** `[Capsule!]!` -> `Capsule`; `String!` -> `String`. */
function namedType(type: TypeNode): string {
  if (type.kind === Kind.NAMED_TYPE) return type.name.value;
  return namedType(type.type);
}

for (const definition of schema.definitions) {
  if (definition.kind !== Kind.OBJECT_TYPE_DEFINITION) continue;
  const fields = new Map<string, string | null>();
  for (const field of definition.fields ?? []) {
    fields.set(field.name.value, namedType(field.type));
  }
  entities.set(definition.name.value, fields);
}

expect("schema parses", entities.size > 0, `${entities.size} entity types`);

/**
 * Fields graph-node adds that the schema file does not declare.
 *
 * `id` is on every entity by construction. `_meta` is the indexer's own status
 * object, which is why it can be asked for and is not in `schema.graphql`.
 */
const GENERATED_ENTITY_FIELDS = new Set(["id", "_change_block"]);
const META_FIELDS = new Set(["block", "deployment", "hasIndexingErrors"]);
const META_BLOCK_FIELDS = new Set(["hash", "number", "timestamp", "parentHash"]);

/**
 * Root query fields graph-node generates per entity: `capsule(id:)` and
 * `capsules(where:, first:, ...)`. Pluralisation is naive on purpose — it
 * matches graph-node's own rule, which is to lowercase the type and append
 * `s`, and a type this rule got wrong would fail here rather than at runtime.
 */
function rootFieldEntity(field: string): string | null {
  for (const name of entities.keys()) {
    const singular = name.charAt(0).toLowerCase() + name.slice(1);
    if (field === singular || field === `${singular}s`) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Walk the query.
// ---------------------------------------------------------------------------
const query = parse(FLEET_QUERY);

function walk(selections: SelectionSetNode, entity: string, path: string): void {
  const fields = entities.get(entity);
  if (fields === undefined) {
    expect(path, false, `no entity named ${entity} in schema.graphql`);
    return;
  }
  for (const selection of selections.selections) {
    if (selection.kind !== Kind.FIELD) continue;
    const field = selection as FieldNode;
    const name = field.name.value;
    const where = `${path}.${name}`;

    if (GENERATED_ENTITY_FIELDS.has(name)) {
      expect(where, true);
      continue;
    }
    if (!fields.has(name)) {
      expect(where, false, `${entity} has no field "${name}"`);
      continue;
    }
    expect(where, true);

    if (field.selectionSet !== undefined) {
      const target = fields.get(name);
      if (target === null || target === undefined) {
        expect(where, false, `"${name}" is a scalar but the query selects into it`);
        continue;
      }
      walk(field.selectionSet, target, where);
    }
  }
}

for (const definition of query.definitions) {
  if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
  for (const selection of definition.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) continue;
    const field = selection as FieldNode;
    const name = field.name.value;

    if (name === "_meta") {
      for (const inner of field.selectionSet?.selections ?? []) {
        if (inner.kind !== Kind.FIELD) continue;
        const metaField = inner.name.value;
        expect(`_meta.${metaField}`, META_FIELDS.has(metaField), `_meta has no field "${metaField}"`);
        if (metaField === "block") {
          for (const blockField of inner.selectionSet?.selections ?? []) {
            if (blockField.kind !== Kind.FIELD) continue;
            const bf = blockField.name.value;
            expect(`_meta.block.${bf}`, META_BLOCK_FIELDS.has(bf), `_meta.block has no field "${bf}"`);
          }
        }
      }
      continue;
    }

    const entity = rootFieldEntity(name);
    if (entity === null) {
      expect(name, false, "no entity in schema.graphql generates this root field");
      continue;
    }
    expect(`${name} -> ${entity}`, true);
    if (field.selectionSet !== undefined) walk(field.selectionSet, entity, name);
  }
}

// ---------------------------------------------------------------------------
// 3. The manifest points at the minter this app is configured for.
//
// Skipped rather than failed when the environment is absent, so the check runs
// in CI and on a fresh checkout. When it does run it is the difference between
// "the subgraph is empty" and "the subgraph is indexing a contract nobody uses
// any more", which look identical from the dashboard.
// ---------------------------------------------------------------------------
const manifest = readFileSync(manifestPath, "utf8");
const addressMatch = /address:\s*"(0x[0-9a-fA-F]{40})"/.exec(manifest);
const blockMatch = /startBlock:\s*(\d+)/.exec(manifest);

expect("manifest names an address", addressMatch !== null, "no `address:` in subgraph.yaml");
expect("manifest names a startBlock", blockMatch !== null, "no `startBlock:` in subgraph.yaml");

const envAddress = process.env.CAPSULE_MINTER_ADDRESS;
const envBlock = process.env.CAPSULE_MINTER_BLOCK;

if (envAddress === undefined || envBlock === undefined) {
  console.log("  ·     minter address/block not checked — CAPSULE_MINTER_* not in the environment");
} else {
  expect(
    "manifest minter matches CAPSULE_MINTER_ADDRESS",
    addressMatch !== null && addressMatch[1].toLowerCase() === envAddress.toLowerCase(),
    `subgraph.yaml ${addressMatch?.[1]} vs env ${envAddress}`,
  );
  expect(
    "manifest startBlock matches CAPSULE_MINTER_BLOCK",
    blockMatch !== null && blockMatch[1] === envBlock.trim(),
    `subgraph.yaml ${blockMatch?.[1]} vs env ${envBlock}`,
  );
}

// ---------------------------------------------------------------------------
const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  if (check.ok) console.log(`  ok    ${check.name}`);
  else console.log(`  DRIFT ${check.name} — ${check.detail}`);
}
console.log("");
if (failed.length > 0) {
  console.error(`✗ ${failed.length} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`the fleet query matches subgraph/schema.graphql (${checks.length} checks)`);
