"use client";
import { createContext, useContext } from "react";
import type { AppConfig } from "./contracts";
export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) { super(message); this.name = "ApiError"; }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers }, cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message ?? `The request could not be completed (${response.status}).`, response.status, data);
  return data as T;
}
export function post<T>(path: string, body: unknown = {}): Promise<T> { return api<T>(path, { method: "POST", body: JSON.stringify(body) }); }
export const ConfigContext = createContext<{ config: AppConfig | null; loading: boolean; error: string | null; refresh: () => Promise<void> }>({ config: null, loading: true, error: null, refresh: async () => {} });
export const useAppConfig = () => useContext(ConfigContext);
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }
export function formatBytes(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }
