/**
 * Structural parser for raw Zcash transactions: v4 (Sapling), v5 (ZIP-225) and v6 (ZIP-229,
 * Ironwood). It counts each bundle's parts and must consume exactly every byte; it does not verify
 * proofs or signatures. nConsensusBranchId is opaque so a new network upgrade never breaks parsing.
 */
import { ByteReader, ZcashCodecError } from "./bytes.ts";

export { ZcashCodecError } from "./bytes.ts";

export interface TxSummary {
  version: number;
  versionGroupId: number;
  /** nConsensusBranchId (v5/v6). v4 transactions do not serialize one: 0. */
  branchId: number;
  expiryHeight: number;
  transparentInputs: number;
  transparentOutputs: number;
  saplingSpends: number;
  saplingOutputs: number;
  orchardActions: number;
  ironwoodActions: number;
}

const OVERWINTERED_FLAG = 0x8000_0000;
const VERSION_GROUP_IDS: Readonly<Record<number, number>> = {
  4: 0x892f2085,
  5: 0x26a7270a,
  6: 0xd884b698,
};

const SIGNATURE = 64;
const ANCHOR = 32;
const VALUE_BALANCE = 8;
const SAPLING_PROOF = 192;
const SAPLING_SPEND_V4 = 384;
const SAPLING_OUTPUT_V4 = 948;
const SAPLING_SPEND_V5 = 96;
const SAPLING_OUTPUT_V5 = 756;
const JOINSPLIT_V4 = 1698;
const JOINSPLIT_PUBKEY = 32;
const ACTION = 820;

function readTransparent(reader: ByteReader): { inputs: number; outputs: number } {
  const inputs = reader.compactSize();
  for (let i = 0; i < inputs; i++) {
    reader.skip(36); // prevout (txid, index)
    reader.skip(reader.compactSize()); // scriptSig
    reader.skip(4); // nSequence
  }
  const outputs = reader.compactSize();
  for (let i = 0; i < outputs; i++) {
    reader.skip(8); // value
    reader.skip(reader.compactSize()); // scriptPubKey
  }
  return { inputs, outputs };
}

function readSaplingV5(reader: ByteReader): { spends: number; outputs: number } {
  const spends = reader.compactSize();
  reader.skip(spends * SAPLING_SPEND_V5);
  const outputs = reader.compactSize();
  reader.skip(outputs * SAPLING_OUTPUT_V5);
  if (spends + outputs > 0) reader.skip(VALUE_BALANCE);
  if (spends > 0) reader.skip(ANCHOR);
  reader.skip(spends * (SAPLING_PROOF + SIGNATURE) + outputs * SAPLING_PROOF);
  if (spends + outputs > 0) reader.skip(SIGNATURE); // bindingSigSapling
  return { spends, outputs };
}

/** An Orchard-encoded action bundle (v5/v6 Orchard, v6 Ironwood). Returns the action count. */
function readActionBundle(reader: ByteReader): number {
  const actions = reader.compactSize();
  if (actions === 0) return 0;
  reader.skip(actions * ACTION);
  reader.skip(1 + VALUE_BALANCE + ANCHOR); // flags, valueBalance, anchor
  reader.skip(reader.compactSize()); // aggregated proofs
  reader.skip(actions * SIGNATURE + SIGNATURE); // spendAuthSigs, bindingSig
  return actions;
}

function parseV4(reader: ByteReader, versionGroupId: number): TxSummary {
  const transparent = readTransparent(reader);
  reader.skip(4); // nLockTime
  const expiryHeight = reader.u32le();
  reader.skip(VALUE_BALANCE);
  const spends = reader.compactSize();
  reader.skip(spends * SAPLING_SPEND_V4);
  const outputs = reader.compactSize();
  reader.skip(outputs * SAPLING_OUTPUT_V4);
  const joinSplits = reader.compactSize();
  reader.skip(joinSplits * JOINSPLIT_V4);
  if (joinSplits > 0) reader.skip(JOINSPLIT_PUBKEY + SIGNATURE);
  if (spends + outputs > 0) reader.skip(SIGNATURE);
  return {
    version: 4,
    versionGroupId,
    branchId: 0,
    expiryHeight,
    transparentInputs: transparent.inputs,
    transparentOutputs: transparent.outputs,
    saplingSpends: spends,
    saplingOutputs: outputs,
    orchardActions: 0,
    ironwoodActions: 0,
  };
}

function parseV5OrV6(reader: ByteReader, version: 5 | 6, versionGroupId: number): TxSummary {
  const branchId = reader.u32le();
  reader.skip(4); // lock_time
  const expiryHeight = reader.u32le();
  const transparent = readTransparent(reader);
  const sapling = readSaplingV5(reader);
  const orchardActions = readActionBundle(reader);
  const ironwoodActions = version === 6 ? readActionBundle(reader) : 0;
  return {
    version,
    versionGroupId,
    branchId,
    expiryHeight,
    transparentInputs: transparent.inputs,
    transparentOutputs: transparent.outputs,
    saplingSpends: sapling.spends,
    saplingOutputs: sapling.outputs,
    orchardActions,
    ironwoodActions,
  };
}

/** Parses a raw transaction. Throws ZcashCodecError if it is malformed or not v4/v5/v6. */
export function parseTxSummary(raw: Uint8Array): TxSummary {
  if (!(raw instanceof Uint8Array)) throw new ZcashCodecError("Expected raw transaction bytes");
  const reader = new ByteReader(raw);
  const header = reader.u32le();
  const version = header & 0x7fff_ffff;
  const expectedGroup = VERSION_GROUP_IDS[version];
  if ((header & OVERWINTERED_FLAG) === 0 || expectedGroup === undefined) {
    throw new ZcashCodecError("Unsupported transaction version");
  }
  const versionGroupId = reader.u32le();
  if (versionGroupId !== expectedGroup) throw new ZcashCodecError("Unexpected version group id");
  const summary =
    version === 4
      ? parseV4(reader, versionGroupId)
      : parseV5OrV6(reader, version === 5 ? 5 : 6, versionGroupId);
  reader.assertEnd();
  return summary;
}

/**
 * Whether the transaction can carry a shielded payment to a merchant's Unified Address. Since
 * NU6.3 the Orchard pool accepts no new value, so Orchard actions alone cannot pay anyone.
 */
export function isReceivable(s: TxSummary): boolean {
  return s.ironwoodActions > 0 || s.saplingOutputs > 0;
}
