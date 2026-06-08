import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let connectionAvailable: boolean | null = null;
let checkedAt = 0;

export function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL ??
    "postgres://fetchgithub:fetchgithub@127.0.0.1:5433/fetchgithub"
  );
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: 5,
      idleTimeoutMillis: 10_000
    });
  }

  return pool;
}

export async function isDatabaseAvailable() {
  const now = Date.now();
  if (connectionAvailable !== null && now - checkedAt < 5_000) {
    return connectionAvailable;
  }

  try {
    await getPool().query("select 1");
    connectionAvailable = true;
    checkedAt = now;
  } catch {
    connectionAvailable = false;
    checkedAt = now;
  }

  return connectionAvailable;
}

export function resetDatabaseAvailability() {
  connectionAvailable = null;
}
