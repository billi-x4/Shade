/**
 * Prints a fresh X25519 keypair for sealing uploaded viewing keys, as env lines:
 *
 *   npm run -s keys:seal -w @shade/backend >> seal.env
 *
 * `-s` keeps npm's script banner out of the redirected file (seal.env is gitignored; delete it once
 * the lines are moved). VIEWING_KEY_SEAL_PUBLIC_KEY goes to the API (it seals uploads; docker
 * compose: backend/.env); VIEWING_KEY_SEAL_PRIVATE_KEYS goes to the worker only (it opens them;
 * docker compose: backend/.env.worker). Rotation: give the API the new public key and put the new
 * private key first in the worker's comma list, keeping the old ones while keys sealed to them
 * remain. The env lines go to stdout, guidance to stderr.
 */
import { parseArgs } from "node:util";
import { encodeBase64, generateSealKeyPair, sealKid } from "../platform/crypto.ts";

const USAGE = `Usage: npm run -s keys:seal -w @shade/backend

Prints VIEWING_KEY_SEAL_PUBLIC_KEY and VIEWING_KEY_SEAL_PRIVATE_KEYS lines for a new seal keypair.`;

function main(): number {
  let help: boolean;
  try {
    help = parseArgs({
      options: { help: { type: "boolean", short: "h", default: false } },
      strict: true,
      allowPositionals: false,
    }).values.help;
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (help) {
    console.log(USAGE);
    return 0;
  }

  const { publicKey, privateKey } = generateSealKeyPair();
  console.log(`# Shade viewing-key seal keypair, key id ${sealKid(publicKey)}`);
  console.log("# API: seals viewing keys uploaded in the desk.");
  console.log(`VIEWING_KEY_SEAL_PUBLIC_KEY=${encodeBase64(publicKey)}`);
  console.log("# Worker only. To rotate, put a new key first and keep the old ones after a comma.");
  console.log(`VIEWING_KEY_SEAL_PRIVATE_KEYS=${encodeBase64(privateKey)}`);
  console.error(
    "Store VIEWING_KEY_SEAL_PRIVATE_KEYS only in the worker's environment, never on the API tier or in the repository: anyone holding it can open every uploaded viewing key.",
  );
  return 0;
}

process.exitCode = main();
