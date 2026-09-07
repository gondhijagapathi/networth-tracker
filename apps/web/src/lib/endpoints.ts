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
import { api, query } from './api.js';

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
};
