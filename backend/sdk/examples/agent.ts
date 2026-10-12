/**
 * Agent driver for the demo (PRD §12 step 5): charges a jar with its agent key until the calls run out or
 * the cap is reached.
 *
 *   SHADE_AGENT_KEY=ag_… npm run demo:agent -w @shade/backend -- --jar <jar_id> --times 4 --amount 0.002 --memo api:search
 *
 * Environment (backend/.env is loaded when present):
 *   SHADE_AGENT_KEY  ag_… key issued for the jar in the desk (required; never printed)
 *   SHADE_API_URL    default http://localhost:5173 (the dev web app proxies /v1); use the API origin for a
 *                    deployed Shade, e.g. https://shade-zcash.vercel.app
 *
 * Prints "authorized <amount> · left <remaining>" per charge and "402 JAR_EMPTY · <message>" at the cap.
 * Exit status: 0 when every charge succeeded or the run ended on JAR_EMPTY, 1 on any other error, 2 on bad usage.
 */
import { parseArgs } from "node:util";
import { Shade, ShadeConnectionError, ShadeError } from "../src/index.ts";

const USAGE = `Usage: npm run demo:agent -w @shade/backend -- --jar <jar_id> [--times 4] [--amount 0.002] [--memo api:search]

Environment:
  SHADE_AGENT_KEY  ag_… agent key for the jar (required)
  SHADE_API_URL    Shade API origin (default http://localhost:5173)`;

const MAX_TIMES = 100;

function usage(problem: string): number {
  console.error(`${problem}\n\n${USAGE}`);
  return 2;
}

function explain(err: unknown): string {
  if (err instanceof ShadeConnectionError) return `${err.code} · ${err.message}`;
  if (err instanceof ShadeError) return `${err.status} ${err.code} · ${err.message}`;
  return `error · ${err instanceof Error ? err.message : String(err)}`;
}

interface Flags {
  jar?: string;
  times: string;
  amount: string;
  memo: string;
  help: boolean;
}

function parseFlags(): Flags | string {
  try {
    return parseArgs({
      options: {
        jar: { type: "string" },
        times: { type: "string", default: "4" },
        amount: { type: "string", default: "0.002" },
        memo: { type: "string", default: "api:search" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function main(): Promise<number> {
  const values = parseFlags();
  if (typeof values === "string") return usage(values);
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const jarId = values.jar;
  if (jarId === undefined || jarId === "") return usage("--jar <jar_id> is required.");
  const times = Number(values.times);
  if (!Number.isInteger(times) || times < 1 || times > MAX_TIMES) {
    return usage(`--times must be a whole number from 1 to ${MAX_TIMES}.`);
  }
  const apiKey = process.env.SHADE_AGENT_KEY ?? "";
  if (apiKey === "") return usage("SHADE_AGENT_KEY is not set.");

  let shade: Shade;
  try {
    shade = new Shade({ apiKey, baseUrl: process.env.SHADE_API_URL || "http://localhost:5173" });
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }

  for (let call = 1; call <= times; call++) {
    try {
      const charge = await shade.jars.charge(jarId, {
        amountZec: values.amount,
        memo: values.memo,
      });
      console.log(`authorized ${charge.amountZec} · left ${charge.remainingZec}`);
    } catch (err) {
      if (err instanceof ShadeError && err.code === "JAR_EMPTY") {
        console.log(`${err.status} ${err.code} · ${err.message}`);
        return 0;
      }
      console.error(explain(err));
      return 1;
    }
  }
  return 0;
}

process.exitCode = await main();
