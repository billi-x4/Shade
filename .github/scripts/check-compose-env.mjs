// CI guard for backend/docker-compose.yml (agents.md §5.3: the API tier cannot decrypt viewing
// keys). Reads `docker compose config --format json` on stdin and checks that:
//   - only the worker container receives VIEWING_KEY_SEAL_PRIVATE_KEYS, with the value from
//     backend/.env.worker (argv[2]);
//   - migrate and api never receive it, even when it is also set in the shared backend/.env
//     (argv[3], optional: the value CI planted there);
//   - every backend service still points DATABASE_URL and DATABASE_URL_UNPOOLED at the bundled
//     Postgres (a per-service `environment:` map replaces the anchor's map instead of merging).
//
//   docker compose -f backend/docker-compose.yml config --format json \
//     | node .github/scripts/check-compose-env.mjs <worker-key> [<key-planted-in-.env>]
import { readFileSync } from "node:fs";

const [workerKey, plantedKey] = process.argv.slice(2);
if (!workerKey) {
  console.error("usage: check-compose-env.mjs <worker-key> [<key-planted-in-.env>]");
  process.exit(2);
}

const config = JSON.parse(readFileSync(0, "utf8"));
const failures = [];
const envOf = (name) => {
  const service = config.services?.[name];
  if (!service) failures.push(`service ${name} is missing`);
  return service?.environment ?? {};
};

for (const name of ["migrate", "api"]) {
  const value = envOf(name).VIEWING_KEY_SEAL_PRIVATE_KEYS;
  if (value) {
    const source = value === plantedKey ? " (from the shared .env)" : "";
    failures.push(`${name} receives VIEWING_KEY_SEAL_PRIVATE_KEYS${source}`);
  }
}
if (envOf("worker").VIEWING_KEY_SEAL_PRIVATE_KEYS !== workerKey) {
  failures.push("worker does not receive VIEWING_KEY_SEAL_PRIVATE_KEYS from .env.worker");
}
for (const name of ["migrate", "api", "worker"]) {
  const env = envOf(name);
  for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
    if (!String(env[key] ?? "").includes("@postgres:5432/")) {
      failures.push(`${name} ${key} does not point at the bundled Postgres`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`compose: ${failure}`);
  process.exit(1);
}
console.log("compose: seal private key reaches the worker only; DATABASE_URL intact");
