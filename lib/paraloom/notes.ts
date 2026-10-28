// Local record of the shielded notes this wallet has deposited. Until the
// extension can scan the pool for its own notes (a viewing-key feature), the
// shielded balance is tracked here: the sum of unspent deposits. Each note
// keeps the randomness needed to spend it in a later withdrawal.

// Spend-key note (circuit v2, #293). The note is bound to the account's spend
// public key (derived from the account seed, not stored here); to spend it the
// wallet supplies that account spend privkey plus this note's `blinding`. The
// nullifier is a signature over the commitment — no per-note secret.
export interface ShieldedNote {
  amount: string // lamports, bigint serialized
  blinding: string // hex, 32 bytes (per-note randomizer)
  assetId: string // hex, 32 bytes (all-zero = native SOL)
  // The SPL mint (base58) for a shielded-token note (#779). Absent for native
  // SOL. Kept alongside `assetId` because assetId = mint_to_asset(mint) is a
  // one-way hash, and spending the note must send the mint to the ingress.
  mint?: string
  signature: string // deposit transaction (empty for discovered transfer notes)
  createdAt: number
  spent: boolean
  // Set for notes discovered by scanning transfer ciphertexts (#196). The
  // commitment is the stable identity for received notes (which have no
  // deposit signature) and the de-dup key when re-scanning.
  commitment?: string
  source?: "deposit" | "transfer"
  // Circuit v3 (#350): the note's position in the on-chain incremental tree,
  // recorded at deposit (from DepositNoteEvent) or located by commitment for
  // received notes. Spending needs it for the membership path.
  leafIndex?: number
}

const NOTES_KEY = "paraloom_notes"

type NotesByAccount = Record<string, ShieldedNote[]>

async function readAll(): Promise<NotesByAccount> {
  const stored = await chrome.storage.local.get(NOTES_KEY)
  return (stored[NOTES_KEY] as NotesByAccount) ?? {}
}

async function writeAll(all: NotesByAccount): Promise<void> {
  await chrome.storage.local.set({ [NOTES_KEY]: all })
}

export async function getNotes(account: string): Promise<ShieldedNote[]> {
  const all = await readAll()
  return all[account] ?? []
}

export async function addNote(account: string, note: ShieldedNote): Promise<void> {
  const all = await readAll()
  const existing = all[account] ?? []
  // Idempotent by (non-empty) deposit signature: the same shielded note can be
  // persisted more than once — the early on-submit persist AND the end-of-flow
  // persist AND the recovery scan all target the same deposit — so dedupe here
  // rather than double-counting the balance.
  if (note.signature && existing.some((n) => n.signature === note.signature)) {
    return
  }
  all[account] = [...existing, note]
  await writeAll(all)
}

// Mark the note with this deposit signature as spent (after a withdrawal
// settles), so it no longer counts toward the shielded balance.
export async function markNoteSpent(account: string, signature: string): Promise<void> {
  const all = await readAll()
  const notes = all[account] ?? []
  all[account] = notes.map((n) => (n.signature === signature ? { ...n, spent: true } : n))
  await writeAll(all)
}

// Add a note discovered by scanning transfer ciphertexts (#196), de-duplicated
// by commitment so re-scanning is idempotent.
export async function addDiscoveredNote(account: string, note: ShieldedNote): Promise<void> {
  const all = await readAll()
  const notes = all[account] ?? []
  if (notes.some((n) => n.commitment && n.commitment === note.commitment)) {
    return
  }
  all[account] = [...notes, note]
  await writeAll(all)
}

// Fill in a deposit note's on-chain leaf index once it is known. The note is
// persisted at submit time (before the index can be resolved) so its blinding is
// never orphaned (#791); this finalizes it by commitment. A no-op if the note is
// gone. Only writes when the index actually changes, to avoid a redundant store.
export async function setNoteLeafIndex(
  account: string,
  commitment: string,
  leafIndex: number
): Promise<void> {
  const all = await readAll()
  const notes = all[account] ?? []
  let changed = false
  all[account] = notes.map((n) => {
    if (n.commitment === commitment && n.leafIndex !== leafIndex) {
      changed = true
      return { ...n, leafIndex }
    }
    return n
  })
  if (changed) await writeAll(all)
}

// Mark a note spent by its commitment (used for transfer inputs/outputs, which
// are identified by commitment rather than a deposit signature).
export async function markNoteSpentByCommitment(account: string, commitment: string): Promise<void> {
  const all = await readAll()
  const notes = all[account] ?? []
  all[account] = notes.map((n) => (n.commitment === commitment ? { ...n, spent: true } : n))
  await writeAll(all)
}

// Mark exactly the given note spent, by whichever identity is unique to it
// (#718). Deposit notes carry a non-empty `signature` and no `commitment`;
// received and change notes carry a `commitment` and an empty `signature`.
// Matching on `signature` alone flips every empty-signature note at once —
// received and change notes vanish from the balance and re-scan does not bring
// them back — so prefer the commitment, and never match on an empty string.
export async function markNoteSpentByIdentity(account: string, note: ShieldedNote): Promise<void> {
  if (note.commitment) {
    await markNoteSpentByCommitment(account, note.commitment)
  } else if (note.signature) {
    await markNoteSpent(account, note.signature)
  }
  // A note with neither identity cannot be addressed; leaving it is safe (the
  // on-chain nullifier set is the authoritative double-spend gate) and is not
  // reachable from the current note-creation paths, which always set one.
}

// Native SOL shielded balance, in lamports. SPL notes (#779) are EXCLUDED:
// their `amount` is in the token's own base units (e.g. 6-decimal USDC), so
// summing them as lamports would corrupt the SOL figure. A note is native iff
// it carries no `mint`. Use shieldedTokenBalances() for the SPL side.
export async function shieldedBalance(account: string): Promise<bigint> {
  const notes = await getNotes(account)
  return notes
    .filter((n) => !n.spent && !n.mint)
    .reduce((sum, n) => sum + BigInt(n.amount), 0n)
}

// Unspent shielded SPL balances keyed by base58 mint (#779). Each amount is in
// that mint's own base units, kept separate from the native lamports sum.
export async function shieldedTokenBalances(
  account: string
): Promise<Record<string, bigint>> {
  const notes = await getNotes(account)
  const byMint: Record<string, bigint> = {}
  for (const n of notes) {
    if (n.spent || !n.mint) continue
    byMint[n.mint] = (byMint[n.mint] ?? 0n) + BigInt(n.amount)
  }
  return byMint
}

export const PHANTOM_NOTE_GRACE_MS = 120_000

// Reconcile out phantom change/received notes whose commitment is absent from
// the on-chain tree after the settlement grace window. Deposit notes carry a
// trusted on-chain leafIndex and are untouched; only commitment-indexed notes
// (leafIndex === undefined && !!commitment) older than `graceMs` are checked.
// Used for BOTH native SOL notes and SPL token notes before selection so a
// stale SPL change note cannot pass selection and abort a token swap after
// self-funded gas SOL has already been withdrawn and spent on ATA creation.
export async function reconcilePhantomNotes(
  account: string,
  notes: ShieldedNote[],
  fetchLeaves: () => Promise<{ commitmentHex: string }[]>,
  now = Date.now(),
  graceMs = PHANTOM_NOTE_GRACE_MS
): Promise<ShieldedNote[]> {
  const suspects = notes.filter(
    (n) =>
      !n.spent &&
      n.leafIndex === undefined &&
      !!n.commitment &&
      now - n.createdAt > graceMs
  )
  if (suspects.length === 0) return notes

  let onchain: Set<string>
  try {
    const leaves = await fetchLeaves()
    onchain = new Set(leaves.map((l) => l.commitmentHex))
  } catch {
    return notes // cannot rebuild the tree safely — drop nothing
  }

  const dropped = new Set<string>()
  for (const n of suspects) {
    if (n.commitment && !onchain.has(n.commitment)) {
      await markNoteSpentByCommitment(account, n.commitment)
      dropped.add(n.commitment)
    }
  }
  if (dropped.size > 0) {
    console.log(
      `[paraloom] reconciled ${dropped.size} phantom note(s) not present on-chain`
    )
  }
  return notes.filter((n) => !(n.commitment && dropped.has(n.commitment)))
}
