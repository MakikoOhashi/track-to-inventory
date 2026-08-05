import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, normalize } from "node:path";

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

loadEnv(".env.local");
loadEnv("../../.env.local");

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const outputDir = process.argv[2];

if (!url || !key || !outputDir) {
  console.error("Usage: supabase-final-backup.mts <output-dir>");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
mkdirSync(outputDir, { recursive: true });
const TABLES = ["shipments", "inventory_sync_ledger"];

function safePath(root: string, objectPath: string): string {
  const target = normalize(join(root, objectPath));
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error(`Unsafe storage path: ${objectPath}`);
  }
  return target;
}

async function main() {
  const tableCounts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows: unknown[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase.from(table).select("*").range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
      from += data.length;
    }
    writeFileSync(join(outputDir, `${table}.json`), JSON.stringify(rows, null, 2));
    tableCounts[table] = rows.length;
  }

  const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
  if (bucketError) throw bucketError;

  const openApi = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!openApi.ok) throw new Error(`PostgREST schema export failed: ${openApi.status}`);
  writeFileSync(join(outputDir, "postgrest-openapi.json"), JSON.stringify(await openApi.json(), null, 2));

  const manifest: Array<Record<string, unknown>> = [];
  let fileCount = 0;
  let byteCount = 0;

  for (const bucket of buckets ?? []) {
    const bucketDir = join(outputDir, "storage", bucket.id);
    mkdirSync(bucketDir, { recursive: true });
    async function walk(prefix: string): Promise<void> {
      let offset = 0;
      while (true) {
      const { data: objects, error } = await supabase.storage
          .from(bucket.id)
          .list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`${bucket.id}: ${error.message}`);
      if (!objects?.length) break;

      for (const object of objects) {
        const objectPath = prefix ? `${prefix}/${object.name}` : object.name;
        if (!object.id) {
          await walk(objectPath);
          continue;
        }
        const { data, error: downloadError } = await supabase.storage
          .from(bucket.id)
          .download(objectPath);
        if (downloadError) throw new Error(`${bucket.id}/${objectPath}: ${downloadError.message}`);
        const bytes = Buffer.from(await data.arrayBuffer());
        const filePath = safePath(bucketDir, objectPath);
        mkdirSync(join(filePath, ".."), { recursive: true });
        writeFileSync(filePath, bytes);
        fileCount += 1;
        byteCount += bytes.byteLength;
        manifest.push({ bucket: bucket.id, path: objectPath, bytes: bytes.byteLength, metadata: object });
      }

      offset += objects.length;
      if (objects.length < 1000) break;
      }
    }
    await walk("");
  }

  writeFileSync(
    join(outputDir, "storage-manifest.json"),
    JSON.stringify({ exportedAt: new Date().toISOString(), buckets, fileCount, byteCount, objects: manifest }, null, 2),
  );
  console.log(JSON.stringify({ type: "supabase_backup", tableCounts, bucketCount: buckets?.length ?? 0, fileCount, byteCount, outputDir }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
