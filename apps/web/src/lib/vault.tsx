/**
 * The unlocked vault, as a React context.
 *
 * One provider holds the keys and nothing else in the application ever sees them. Screens
 * ask it to `decrypt` an envelope or `encrypt` an object; they never touch a `CryptoKey`,
 * which keeps the number of places that could accidentally persist one down to zero.
 *
 * The lock is real:
 *
 *   - Keys live in a ref, not in state that could end up serialised, and never in
 *     `localStorage`. A reload locks the vault, and that is the design.
 *   - **Fifteen minutes idle and it locks itself.** The timer is reset by real interaction
 *     rather than by rendering, so a dashboard left open on a screen does not count as
 *     somebody sitting in front of it.
 *   - Switching tabs away does not lock it — that would make the app unusable next to a
 *     bank's website, which is exactly when it is used — but the idle timer keeps running.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  DEFAULT_KDF_PARAMS,
  type CipherEnvelope,
  type PublicKeyJwk,
  type VaultStatus,
} from '@networth/shared';
import { endpoints } from './endpoints.js';
import type * as VaultCrypto from './vaultCrypto.js';

/**
 * The crypto module, loaded on demand.
 *
 * Argon2id ships as WASM and is the second-largest thing in the bundle after the charts.
 * Nobody needs it to look at their net worth, so it arrives when a vault is first touched —
 * the same trade `Dashboard.tsx` makes for Recharts. One promise, cached, so the second
 * call does not re-fetch.
 */
let loading: Promise<typeof VaultCrypto> | null = null;
const vaultCrypto = (): Promise<typeof VaultCrypto> => (loading ??= import('./vaultCrypto.js'));

/** Fifteen minutes, per docs/SECURITY-MODEL.md. */
export const IDLE_LOCK_MS = 15 * 60 * 1000;

export type VaultState = 'loading' | 'absent' | 'locked' | 'unlocked';

interface VaultValue {
  state: VaultState;
  status: VaultStatus | null;
  /** Re-read the item and document counts after a change. */
  refresh: () => Promise<void>;

  create: (passphrase: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  changePassphrase: (current: string, next: string) => Promise<void>;

  encrypt: (value: unknown) => Promise<CipherEnvelope>;
  decrypt: <T>(envelope: CipherEnvelope) => Promise<T>;
  encryptFile: (bytes: ArrayBuffer) => Promise<Uint8Array>;
  decryptFile: (blob: ArrayBuffer) => Promise<Uint8Array>;

  /** Wrap the data key to a nominee's public key, for escrow. */
  wrapForNominee: (jwk: PublicKeyJwk) => Promise<string>;
  /** Open an owner's data key that was escrowed to this user. Returns a decrypt-only view. */
  openEstate: (wrappedDek: string) => Promise<EstateKey>;
}

/** A released estate's key, scoped to reading. An heir decrypts; they never write. */
export interface EstateKey {
  decrypt: <T>(envelope: CipherEnvelope) => Promise<T>;
  decryptFile: (blob: ArrayBuffer) => Promise<Uint8Array>;
}

const VaultContext = createContext<VaultValue | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<VaultState>('loading');
  const [status, setStatus] = useState<VaultStatus | null>(null);

  // Refs, not state. A key in state would be captured by every closure that renders, and
  // there is no reason for React to know these values changed — `state` says all the UI
  // needs to know.
  const dek = useRef<CryptoKey | null>(null);
  const privateKey = useRef<CryptoKey | null>(null);

  const lock = useCallback(() => {
    dek.current = null;
    privateKey.current = null;
    setState((previous) => (previous === 'unlocked' ? 'locked' : previous));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await endpoints.vaultStatus();
      setStatus(next);
      setState((previous) => {
        if (!next.initialised) return 'absent';
        // A refresh must never silently unlock or lock: it reports counts, not keys.
        return previous === 'unlocked' ? 'unlocked' : 'locked';
      });
    } catch {
      setState('absent');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* ---------------------------------------------------------------------- */
  /* Idle lock                                                              */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (state !== 'unlocked') return;

    let timer = window.setTimeout(lock, IDLE_LOCK_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, IDLE_LOCK_MS);
    };

    // Pointer, keyboard and scroll — evidence of a person, not of a render.
    const events = ['pointerdown', 'keydown', 'scroll'] as const;
    for (const event of events) window.addEventListener(event, reset, { passive: true });

    return () => {
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, reset);
    };
  }, [state, lock]);

  /* ---------------------------------------------------------------------- */
  /* Setup and unlock                                                       */
  /* ---------------------------------------------------------------------- */

  const create = useCallback(
    async (passphrase: string) => {
      const { deriveKek, generateDek, generateKeypair, randomSalt, wrapDek } = await vaultCrypto();

      const kdfSalt = randomSalt();
      const kek = await deriveKek(passphrase, kdfSalt, DEFAULT_KDF_PARAMS);
      const key = await generateDek();
      const keypair = await generateKeypair(kek);

      await endpoints.createVault({
        kdfSalt,
        kdfParams: DEFAULT_KDF_PARAMS,
        wrappedDek: await wrapDek(kek, key),
        publicKeyJwk: keypair.publicKeyJwk,
        wrappedPrivateKey: keypair.wrappedPrivateKey,
      });

      dek.current = key;
      privateKey.current = keypair.privateKey;
      setState('unlocked');
      await refresh();
    },
    [refresh],
  );

  const unlock = useCallback(async (passphrase: string) => {
    const { deriveKek, unwrapDek, unwrapPrivateKey } = await vaultCrypto();

    const { keys } = await endpoints.unlockVault();
    const kek = await deriveKek(passphrase, keys.kdfSalt, keys.kdfParams);

    // Throws on a wrong passphrase, here, in the browser. Nothing was asked of the server.
    dek.current = await unwrapDek(kek, keys.wrappedDek);
    privateKey.current = await unwrapPrivateKey(kek, keys.wrappedPrivateKey);

    // Only now, once it actually opened, does the backoff get cleared.
    await endpoints.confirmUnlock();
    setState('unlocked');
  }, []);

  const changePassphrase = useCallback(async (current: string, next: string) => {
    const { deriveKek, importPrivateKey, openBytes, randomSalt, sealBytes, unwrapDek, wrapDek } =
      await vaultCrypto();

    const { keys } = await endpoints.unlockVault();
    const oldKek = await deriveKek(current, keys.kdfSalt, keys.kdfParams);

    const key = await unwrapDek(oldKek, keys.wrappedDek);
    // Raw bytes, not text: PKCS#8 is binary and a UTF-8 round trip would corrupt it.
    const pkcs8 = await openBytes(oldKek, keys.wrappedPrivateKey);

    const kdfSalt = randomSalt();
    const newKek = await deriveKek(next, kdfSalt, DEFAULT_KDF_PARAMS);

    await endpoints.rekeyVault({
      kdfSalt,
      kdfParams: DEFAULT_KDF_PARAMS,
      // The data key itself is unchanged, so not one item has to be re-encrypted.
      wrappedDek: await wrapDek(newKek, key),
      wrappedPrivateKey: await sealBytes(newKek, pkcs8),
    });

    dek.current = key;
    privateKey.current = await importPrivateKey(pkcs8);
    setState('unlocked');
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Using the key                                                          */
  /* ---------------------------------------------------------------------- */

  const requireKey = useCallback((): CryptoKey => {
    if (!dek.current) throw new Error('The vault is locked');
    return dek.current;
  }, []);

  const value = useMemo<VaultValue>(
    () => ({
      state,
      status,
      refresh,
      create,
      unlock,
      lock,
      changePassphrase,
      encrypt: async (input) => (await vaultCrypto()).sealJson(requireKey(), input),
      decrypt: async <T,>(envelope: CipherEnvelope) =>
        (await vaultCrypto()).openJson<T>(requireKey(), envelope),
      encryptFile: async (bytes) => (await vaultCrypto()).sealFile(requireKey(), bytes),
      decryptFile: async (blob) => (await vaultCrypto()).openFile(requireKey(), blob),
      wrapForNominee: async (jwk) => (await vaultCrypto()).wrapToNominee(jwk, requireKey()),
      openEstate: async (wrappedDek) => {
        if (!privateKey.current) throw new Error('The vault is locked');
        const { openFile, openJson, unwrapFromOwner } = await vaultCrypto();
        const estateKey = await unwrapFromOwner(privateKey.current, wrappedDek);
        return {
          decrypt: <T,>(envelope: CipherEnvelope) => openJson<T>(estateKey, envelope),
          decryptFile: (blob: ArrayBuffer) => openFile(estateKey, blob),
        };
      },
    }),
    [state, status, refresh, create, unlock, lock, changePassphrase, requireKey],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultValue {
  const value = useContext(VaultContext);
  if (value === null) throw new Error('useVault must be used inside a VaultProvider');
  return value;
}
