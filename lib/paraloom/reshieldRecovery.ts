// Re-shield note recovery, runnable from EITHER the background service worker
// or the popup (both have storage + RPC + the fresh key). Running it in the
// popup on open is the reliable trigger: it needs no app -> content-script ->
// service-worker relay (which can fail with "No SW" when the MV3 worker is
// asleep), and opening the popup itself keeps the context alive.

import { Connection, Keypair, PublicKey } from "@solana/web3.js"

import {
  associatedTokenAddress,
  depositSpl,
  recoverReshieldedNote
} from "~lib/paraloom/bridge"
import { addNote } from "~lib/paraloom/notes"
import type { ReshieldedNote } from "~lib/paraloom/privateSwap"
import { listSwapOutputs, saveSwapOutput } from "~lib/paraloom/swapOutputs"
import { assetIdForMint } from "~lib/prover"

// Persist a re-shielded SPL note against the wallet's shielded account. Called
// the instant a deposit is submitted (via the privateSwap onReshielded callback,
// so a worker eviction cannot orphan it), at the end of the flow, and from the
// recovery scan; addNote dedupes by deposit signature so double-persisting is safe.
export async function persistReshieldedNote(
  shieldedAddress: string,
  note: ReshieldedNote
): Promise<void> {
  await addNote(shieldedAddress, {
    amount: note.amount,
    blinding: note.blindingHex,
    assetId: note.assetId,
    mint: note.mint || undefined,
    signature: note.depositSignature,
    createdAt: Date.now(),
    spent: false,
    source: "deposit"
  })
}

// Recover re-shield notes that landed on-chain but were never persisted (a
// confirmation timeout / worker eviction before the on-submit persist existed),
// AND finish re-shields whose deposit never ran but whose token is still at the
// fresh address. Both leave a shielded balance the portfolio cannot show; this
// makes them appear. Idempotent (addNote dedupes; the reshieldRecovered flag
// skips settled ones) so it is safe to run on every popup open / connect.
export async function recoverReshields(
  connection: Connection,
  shieldedAddress: string
): Promise<number> {
  let recovered = 0
  const outputs = await listSwapOutputs()
  for (const o of outputs) {
    if (!o.reshield || !o.swapSignature || o.outputMint === "SOL") continue
    if (o.reshieldRecovered) continue
    try {
      const mint = new PublicKey(o.outputMint)
      const mintHex = Buffer.from(mint.toBytes()).toString("hex")

      // Case A: the deposit already landed — recover its note (blinding) from
      // the on-chain instruction so the balance is visible and spendable.
      const rec = await recoverReshieldedNote(connection, o.freshAddress)
      if (rec) {
        await persistReshieldedNote(shieldedAddress, {
          assetId: await assetIdForMint(mintHex),
          mint: o.outputMint,
          amount: rec.amount,
          blindingHex: rec.blindingHex,
          depositSignature: rec.signature
        })
        await saveSwapOutput({ ...o, reshieldRecovered: true })
        recovered++
        console.log(`[paraloom] recovered orphaned reshield note at ${o.freshAddress}`)
        continue
      }

      // Case B: the deposit never ran but the token is still at the fresh
      // address — finish the re-shield now.
      const fresh = Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(o.freshSecretKeyHex, "hex"))
      )
      const ata = associatedTokenAddress(fresh.publicKey, mint)
      const bal = await connection.getTokenAccountBalance(ata).catch(() => null)
      const tokenAmount = bal ? BigInt(bal.value.amount) : 0n
      if (tokenAmount > 0n) {
        const assetId = await assetIdForMint(mintHex)
        await depositSpl(
          connection,
          fresh,
          shieldedAddress,
          mint,
          tokenAmount,
          assetId,
          undefined,
          (note) =>
            persistReshieldedNote(shieldedAddress, {
              assetId,
              mint: o.outputMint,
              amount: tokenAmount.toString(),
              blindingHex: Buffer.from(note.blinding).toString("hex"),
              depositSignature: note.signature
            })
        )
        await saveSwapOutput({ ...o, reshieldRecovered: true })
        recovered++
        console.log(`[paraloom] finished pending reshield at ${o.freshAddress}`)
      }
    } catch (e) {
      console.log(
        `[paraloom] reshield recovery failed at ${o.freshAddress}: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  }
  return recovered
}
