import crypto from "node:crypto";

const password = process.argv[2];

if (!password) {
  console.error("Usage: node scripts/hash-password.mjs <password>");
  process.exitCode = 1;
} else {
  const salt = crypto.randomBytes(16);
  crypto.scrypt(password, salt, 64, (error, key) => {
    if (error) {
      throw error;
    }

    console.log(`scrypt:${salt.toString("base64url")}:${key.toString("base64url")}`);
  });
}
