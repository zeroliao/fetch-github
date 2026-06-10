import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPool, isDatabaseAvailable } from "./db";

export const AUTH_COOKIE_NAME = "fetchgithub_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const localSessionsPath = path.join(process.cwd(), "runtime", "auth-sessions.json");

interface AuthSession {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

interface LocalSessionState {
  sessions: AuthSession[];
}

export interface AuthUser {
  id: string;
  username: string;
  role: "admin";
}

type LoginResult =
  | { ok: true; session: AuthSession }
  | { ok: false; reason: "auth_not_configured" | "invalid_credentials" };

export async function loginAdmin(username: string, password: string): Promise<LoginResult> {
  const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  if (!passwordHash) {
    return { ok: false, reason: "auth_not_configured" as const };
  }

  const validUsername = timingSafeEqualText(username, adminUsername);
  const validPassword = await verifyPassword(password, passwordHash);
  if (!validUsername || !validPassword) {
    return { ok: false, reason: "invalid_credentials" as const };
  }

  const session = await createSession({
    userId: `admin:${adminUsername}`
  });

  return { ok: true, session };
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (!sessionId) {
    return null;
  }

  const session = await getSession(sessionId);
  if (!session) {
    return null;
  }

  const username = process.env.ADMIN_USERNAME ?? "admin";
  return {
    id: session.userId,
    username,
    role: "admin"
  };
}

export async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) {
    return {
      user: null,
      response: NextResponse.json({ error: "未登录或登录已过期。" }, { status: 401 })
    };
  }

  return {
    user,
    response: null
  };
}

export function setSessionCookie(response: NextResponse, session: AuthSession) {
  response.cookies.set(AUTH_COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.expiresAt)
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0)
  });
}

export async function destroyCurrentSession() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (!sessionId) {
    return;
  }

  await deleteSession(sessionId);
}

async function createSession(input: { userId: string }): Promise<AuthSession> {
  const now = new Date();
  const session: AuthSession = {
    id: crypto.randomBytes(32).toString("base64url"),
    userId: input.userId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString()
  };

  if (await isDatabaseAvailable()) {
    await getPool().query(
      `insert into auth_sessions (id, user_id, expires_at, created_at)
       values ($1,$2,$3,$4)`,
      [session.id, session.userId, session.expiresAt, session.createdAt]
    );
    return session;
  }

  const state = await loadLocalSessions();
  state.sessions = [
    session,
    ...state.sessions.filter((item) => new Date(item.expiresAt).getTime() > Date.now())
  ];
  await saveLocalSessions(state);
  return session;
}

async function getSession(sessionId: string): Promise<AuthSession | null> {
  if (await isDatabaseAvailable()) {
    const result = await getPool().query(
      `select id, user_id, expires_at, created_at
       from auth_sessions
       where id=$1 and expires_at > now()`,
      [sessionId]
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          expiresAt: toIso(row.expires_at),
          createdAt: toIso(row.created_at)
        }
      : null;
  }

  const state = await loadLocalSessions();
  const now = Date.now();
  const session = state.sessions.find(
    (item) => item.id === sessionId && new Date(item.expiresAt).getTime() > now
  );
  const liveSessions = state.sessions.filter((item) => new Date(item.expiresAt).getTime() > now);
  if (liveSessions.length !== state.sessions.length) {
    await saveLocalSessions({ sessions: liveSessions });
  }

  return session ?? null;
}

async function deleteSession(sessionId: string) {
  if (await isDatabaseAvailable()) {
    await getPool().query(`delete from auth_sessions where id=$1`, [sessionId]);
    return;
  }

  const state = await loadLocalSessions();
  state.sessions = state.sessions.filter((session) => session.id !== sessionId);
  await saveLocalSessions(state);
}

async function verifyPassword(password: string, storedHash: string) {
  const parsed = parseScryptHash(storedHash);
  if (!parsed) {
    return false;
  }

  const derived = await scrypt(password, parsed.salt, parsed.key.length);
  return crypto.timingSafeEqual(derived, parsed.key);
}

function parseScryptHash(value: string) {
  const [algorithm, salt, key] = value.split(":");
  if (algorithm !== "scrypt" || !salt || !key) {
    return null;
  }

  try {
    return {
      salt: Buffer.from(salt, "base64url"),
      key: Buffer.from(key, "base64url")
    };
  } catch {
    return null;
  }
}

function scrypt(password: string, salt: Buffer, keyLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function timingSafeEqualText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

async function loadLocalSessions(): Promise<LocalSessionState> {
  try {
    return JSON.parse(await readFile(localSessionsPath, "utf8")) as LocalSessionState;
  } catch {
    return { sessions: [] };
  }
}

async function saveLocalSessions(state: LocalSessionState) {
  await mkdir(path.dirname(localSessionsPath), { recursive: true });
  await writeFile(localSessionsPath, JSON.stringify(state, null, 2), "utf8");
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
