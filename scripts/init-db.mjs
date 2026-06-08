import { readFile } from "node:fs/promises";
import pg from "pg";
import { loadLocalEnv } from "./load-env.mjs";

const { Client } = pg;

loadLocalEnv();

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://fetchgithub:fetchgithub@127.0.0.1:5433/fetchgithub";

const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(schema);
  console.log("Database schema applied.");
} finally {
  await client.end();
}
