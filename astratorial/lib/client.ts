"use client";
import { createContext, useContext } from "react";
import type { AppConfig } from "./contracts";
export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) { super(message); this.name = "ApiError"; }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) cancel();
  else init?.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers }, cache: "no-store" });
    const data = await response.json().catch(reason => { if (controller.signal.aborted) throw reason; return null; });
    if (!response.ok) {
      const fallback = response.status === 401 ? "Your session expired. Reconnect and try again."
        : response.status === 429 ? "Too many requests. Wait a moment, then try again."
        : response.status >= 500 ? "The server is temporarily unavailable. Try again shortly."
        : `The request could not be completed (${response.status}). Please try again.`;
      throw new ApiError(errorMessage(new Error(typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message ?? fallback)), response.status, data);
    }
    if (data === null) throw new ApiError("The server returned an unreadable response. Refresh the connection and try again.", 502);
    return data as T;
  } catch (reason) {
    if (timedOut) throw new ApiError("The server took too long to respond. Your request may still be processing. Check the connection and try again.", 408, { code: "request_timeout" });
    if (init?.signal?.aborted) throw new ApiError("The request was stopped.", 499, { code: "request_cancelled" });
    if (reason instanceof ApiError) throw reason;
    throw new ApiError("We couldn’t reach the server. Check your internet connection and that the app is running, then try again.", 0, { code: "network_error" });
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", cancel);
  }
}
export function post<T>(path: string, body: unknown = {}): Promise<T> { return api<T>(path, { method: "POST", body: JSON.stringify(body) }); }
export const ConfigContext = createContext<{ config: AppConfig | null; loading: boolean; error: string | null; refresh: () => Promise<void> }>({ config: null, loading: true, error: null, refresh: async () => {} });
export const useAppConfig = () => useContext(ConfigContext);
export function errorMessage(error: unknown) { return error instanceof Error ? error.message.replace(/https?:\/\/[^\s<>]+/gi, "[service address]").replace(/sk-[A-Za-z0-9_-]+/g, "[private key]") : "Something went wrong. Please try again."; }
export function formatBytes(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }
