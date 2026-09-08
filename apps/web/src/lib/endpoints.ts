/**
 * Every endpoint this client calls, in one file.
 *
 * Typed against the contracts in `@networth/shared`, which are the same types the server
 * builds its responses from — so a shape that changes on one side stops compiling on the
 * other rather than turning into `undefined` on a dashboard.
 */

import type {
  AllocationResponse,
  AssetQuery,
  AssetRecord,
  AssetStatus,
  AssetSummary,
  AssetType,
  CreateAssetBody,
  CreateInstrumentBody,
  CreateTransactionBody,
  CreateValuationBody,
  DashboardResponse,
  InstrumentRecord,
  NetWorthPoint,
  PerformanceEntry,
  PerformanceResponse,
  TransactionRecord,
  UpdateAssetBody,
  ValuationRecord,
} from '@networth/shared';
import type {
  ClaimKitResponse,
  ConfigureDeadManBody,
  CreateHouseholdBody,
  CreateInviteBody,
  CreateNomineeBody,
  CreateVaultItemBody,
  DeadManStatus,
  EstateSummary,
  HouseholdMemberRecord,
  HouseholdRecord,
  InvitePartnerBody,
  InviteSummary,
  NomineeRecord,
  PriceRefreshResult,
  PriceRefreshSource,
  PublicKeyJwk,
  PublicUser,
  RekeyVaultBody,
  SealEscrowBody,
  SetupVaultBody,
  UpdateNomineeBody,
  UpdateShareModeBody,
  UpdateUserBody,
  UpdateVaultItemBody,
  VaultDocumentRecord,
  VaultItemRecord,
  VaultKeyMaterial,
  VaultStatus,
} from '@networth/shared';
import { api, binary, query, upload } from './api.js';

export const endpoints = {
  dashboard: (params: { months?: number; by?: string; asOf?: string }, signal?: AbortSignal) =>
    api.get<DashboardResponse>(`/analytics/dashboard${query(params)}`, signal),

  netWorth: (params: { months?: number; interval?: string }, signal?: AbortSignal) =>
    api.get<{ series: NetWorthPoint[] }>(`/analytics/networth${query(params)}`, signal),

  allocations: (signal?: AbortSignal) =>
    api.get<{ allocations: Record<string, AllocationResponse> }>(
      '/analytics/allocation/all',
      signal,
    ),

  performance: (signal?: AbortSignal) =>
    api.get<PerformanceResponse>('/analytics/performance', signal),

  assets: (params: Partial<AssetQuery>, signal?: AbortSignal) =>
    api.get<{ assets: AssetSummary[]; total: number }>(
      `/assets${query(params as Record<string, string | number | boolean | undefined>)}`,
      signal,
    ),

  assetCounts: (signal?: AbortSignal) =>
    api.get<{ counts: Array<{ type: AssetType; status: AssetStatus; count: number }> }>(
      '/assets/counts',
      signal,
    ),

  asset: (id: string, signal?: AbortSignal) =>
    api.get<{ asset: AssetRecord }>(`/assets/${id}`, signal),

  assetPerformance: (id: string, signal?: AbortSignal) =>
    api.get<{ performance: PerformanceEntry }>(`/assets/${id}/performance`, signal),

  valuations: (id: string, signal?: AbortSignal) =>
    api.get<{ valuations: ValuationRecord[] }>(`/assets/${id}/valuations`, signal),

  transactions: (id: string, signal?: AbortSignal) =>
    api.get<{ transactions: TransactionRecord[] }>(`/assets/${id}/transactions`, signal),

  createAsset: (body: CreateAssetBody) => api.post<{ asset: AssetRecord }>('/assets', body),

  updateAsset: (id: string, body: UpdateAssetBody) =>
    api.patch<{ asset: AssetRecord }>(`/assets/${id}`, body),

  archiveAsset: (id: string) => api.delete<{ asset: AssetSummary }>(`/assets/${id}`),

  recordValuation: (id: string, body: CreateValuationBody) =>
    api.post<{ valuation: ValuationRecord }>(`/assets/${id}/valuations`, body),

  addTransaction: (id: string, body: CreateTransactionBody) =>
    api.post<{ transaction: TransactionRecord }>(`/assets/${id}/transactions`, body),

  deleteTransaction: (id: string, transactionId: string) =>
    api.delete<void>(`/assets/${id}/transactions/${transactionId}`),

  searchInstruments: (q: string, signal?: AbortSignal) =>
    api.get<{ instruments: InstrumentRecord[] }>(`/instruments${query({ q, limit: 20 })}`, signal),

  createInstrument: (body: CreateInstrumentBody) =>
    api.post<{ instrument: InstrumentRecord }>('/instruments', body),

  refreshPrices: (source: PriceRefreshSource = 'all') =>
    api.post<PriceRefreshResult>('/instruments/refresh', { source }),

  /* ---------------------------------------------------------------------- */
  /* Households                                                             */
  /* ---------------------------------------------------------------------- */

  households: (signal?: AbortSignal) =>
    api.get<{ households: HouseholdRecord[] }>('/households', signal),

  household: (id: string, signal?: AbortSignal) =>
    api.get<{ household: HouseholdRecord }>(`/households/${id}`, signal),

  createHousehold: (body: CreateHouseholdBody) =>
    api.post<{ household: HouseholdRecord }>('/households', body),

  invitePartner: (id: string, body: InvitePartnerBody) =>
    api.post<{ member: HouseholdMemberRecord }>(`/households/${id}/invite`, body),

  acceptHousehold: (id: string) =>
    api.post<{ member: HouseholdMemberRecord }>(`/households/${id}/accept`),

  updateShareMode: (id: string, body: UpdateShareModeBody) =>
    api.patch<{ member: HouseholdMemberRecord }>(`/households/${id}/share`, body),

  leaveHousehold: (id: string, userId: string) =>
    api.delete<void>(`/households/${id}/members/${userId}`),

  /* ---------------------------------------------------------------------- */
  /* Vault                                                                  */
  /* ---------------------------------------------------------------------- */

  vaultStatus: (signal?: AbortSignal) => api.get<VaultStatus>('/vault', signal),

  createVault: (body: SetupVaultBody) => api.post<{ keys: VaultKeyMaterial }>('/vault', body),

  /** Metered and audited on the server; see `lib/rateLimit.ts` for what that does buy. */
  unlockVault: () => api.post<{ keys: VaultKeyMaterial }>('/vault/unlock'),

  confirmUnlock: () => api.post<void>('/vault/unlock/confirm'),

  rekeyVault: (body: RekeyVaultBody) => api.post<{ keys: VaultKeyMaterial }>('/vault/rekey', body),

  vaultItems: (params: { assetId?: string } = {}, signal?: AbortSignal) =>
    api.get<{ items: VaultItemRecord[] }>(`/vault/items${query(params)}`, signal),

  createVaultItem: (body: CreateVaultItemBody) =>
    api.post<{ item: VaultItemRecord }>('/vault/items', body),

  updateVaultItem: (id: string, body: UpdateVaultItemBody) =>
    api.patch<{ item: VaultItemRecord }>(`/vault/items/${id}`, body),

  deleteVaultItem: (id: string) => api.delete<void>(`/vault/items/${id}`),

  vaultDocuments: (params: { assetId?: string } = {}, signal?: AbortSignal) =>
    api.get<{ documents: VaultDocumentRecord[] }>(`/vault/documents${query(params)}`, signal),

  /** The body is ciphertext; the encrypted filename rides in a header. */
  uploadDocument: (ciphertext: Uint8Array, meta: unknown, assetId?: string) =>
    upload<{ document: VaultDocumentRecord }>(
      `/vault/documents${query({ assetId })}`,
      ciphertext,
      meta,
    ),

  downloadDocument: (id: string) => binary(`/vault/documents/${id}/content`),

  deleteDocument: (id: string) => api.delete<void>(`/vault/documents/${id}`),

  /* ---------------------------------------------------------------------- */
  /* Nominees                                                               */
  /* ---------------------------------------------------------------------- */

  nominees: (signal?: AbortSignal) => api.get<{ nominees: NomineeRecord[] }>('/nominees', signal),

  createNominee: (body: CreateNomineeBody) =>
    api.post<{ nominee: NomineeRecord }>('/nominees', body),

  updateNominee: (id: string, body: UpdateNomineeBody) =>
    api.patch<{ nominee: NomineeRecord }>(`/nominees/${id}`, body),

  revokeNominee: (id: string) => api.delete<{ nominee: NomineeRecord }>(`/nominees/${id}`),

  inviteNominee: (id: string) =>
    api.post<{ nominee: NomineeRecord; code: string }>(`/nominees/${id}/invite`),

  nomineePublicKey: (id: string) =>
    api.get<{ publicKeyJwk: PublicKeyJwk }>(`/nominees/${id}/public-key`),

  sealEscrow: (id: string, body: SealEscrowBody) =>
    api.post<{ escrow: NonNullable<NomineeRecord['escrow']> }>(`/nominees/${id}/escrow`, body),

  releaseEscrow: (id: string) =>
    api.post<{ escrow: NonNullable<NomineeRecord['escrow']> }>(`/nominees/${id}/release`),

  /* ---------------------------------------------------------------------- */
  /* Estate                                                                 */
  /* ---------------------------------------------------------------------- */

  estates: (signal?: AbortSignal) => api.get<{ estates: EstateSummary[] }>('/estate', signal),

  estateKey: (ownerId: string) =>
    api.post<{ wrappedDek: string; releasedAt: string }>(`/estate/${ownerId}/key`),

  estateItems: (ownerId: string, signal?: AbortSignal) =>
    api.get<{ items: VaultItemRecord[] }>(`/estate/${ownerId}/items`, signal),

  estateDocuments: (ownerId: string, signal?: AbortSignal) =>
    api.get<{ documents: VaultDocumentRecord[] }>(`/estate/${ownerId}/documents`, signal),

  downloadEstateDocument: (ownerId: string, id: string) =>
    binary(`/estate/${ownerId}/documents/${id}/content`),

  deadman: (signal?: AbortSignal) => api.get<{ deadman: DeadManStatus }>('/estate/deadman', signal),

  configureDeadman: (body: ConfigureDeadManBody) =>
    api.put<{ deadman: DeadManStatus }>('/estate/deadman', body),

  deadmanCheckIn: () => api.post<{ deadman: DeadManStatus }>('/estate/deadman/checkin'),

  deadmanCancel: () => api.post<{ deadman: DeadManStatus }>('/estate/deadman/cancel'),

  claimKit: (params: { ownerId?: string } = {}, signal?: AbortSignal) =>
    api.get<ClaimKitResponse>(`/estate/claim-kit${query(params)}`, signal),

  /* ---------------------------------------------------------------------- */
  /* Administration                                                         */
  /* ---------------------------------------------------------------------- */

  adminUsers: (signal?: AbortSignal) => api.get<{ users: PublicUser[] }>('/admin/users', signal),

  updateUser: (id: string, body: UpdateUserBody) =>
    api.patch<{ user: PublicUser }>(`/admin/users/${id}`, body),

  revokeUserSessions: (id: string) =>
    api.post<{ revoked: number }>(`/admin/users/${id}/revoke-sessions`),

  adminInvites: (signal?: AbortSignal) =>
    api.get<{ invites: InviteSummary[] }>('/admin/invites', signal),

  /** The code comes back exactly once; it is stored only as a hash. */
  createInvite: (body: CreateInviteBody) =>
    api.post<{ invite: InviteSummary; code: string }>('/admin/invites', body),

  revokeInvite: (id: string) => api.delete<void>(`/admin/invites/${id}`),
};
