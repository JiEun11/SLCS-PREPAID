import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
export const auth = url && key ? createClient(url, key).auth : null;

export type Transaction = {
  id: string;
  kind: "credit" | "debit" | "reversal";
  amount: number;
  balanceAfter: number | null;
  createdAt: string;
  actorId?: string;
  reversesId?: string | null;
  reversedById?: string | null;
};

export type Customer = {
  id: string;
  name: string;
  balance: number;
  createdAt: string;
  recentTransaction: Transaction | null;
};

export type Summary = {
  totalBalance: string;
  customerCount: string;
  totalUsed: string;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

const errors: Record<string, string> = {
  authentication_unavailable:
    "관리자 확인 서비스에 연결하지 못했습니다. 다시 확인해 주세요.",
  unauthorized: "로그인 세션이 만료됐습니다. 다시 로그인해 주세요.",
  forbidden: "관리자 권한이 있는 계정으로 로그인해 주세요.",
  insufficient_balance: "잔액이 부족합니다. 현재 잔액을 확인해 주세요.",
  balance_limit: "충전 후 잔액이 허용 한도를 초과합니다.",
  customer_not_found: "고객을 찾을 수 없습니다. 목록을 새로고침해 주세요.",
  idempotency_key_conflict:
    "요청 번호가 이미 사용되었습니다. 거래 내역을 확인해 주세요.",
  invalid_request: "입력값을 확인해 주세요.",
};

export function messageFor(error: unknown) {
  return error instanceof ApiError
    ? (errors[error.code] ??
        "서버에서 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.")
    : "연결 상태를 확인하고 다시 시도해 주세요.";
}

export async function api<T>(
  token: string,
  path: string,
  options: {
    body?: object;
    key?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const headers = new Headers({ Authorization: "Bearer " + token });
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.key) headers.set("Idempotency-Key", options.key);
  const response = await fetch("/api" + path, {
    method: options.body ? "POST" : "GET",
    body: options.body && JSON.stringify(options.body),
    signal: options.signal,
    headers,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(response.status, data?.error ?? "request_failed");
  if (!data || typeof data !== "object")
    throw new Error("Invalid API response");
  return data as T;
}
