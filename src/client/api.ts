/** REST API クライアント（設計 §5） */

import { ROOM_AUTH_HEADER } from "../shared/constants.ts";
import type {
  CreateRoomResponse,
  JoinResponse,
  ListMessagesResponse,
  MessageDataResponse,
  MessageKind,
  PostMessageResponse,
  SubscribeRequest,
  VapidResponse,
} from "../shared/types.ts";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

async function call<T>(
  method: string,
  path: string,
  opts: { auth?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.auth) headers[ROOM_AUTH_HEADER] = opts.auth;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const code =
      typeof (data as { error?: unknown })?.error === "string"
        ? String((data as { error: string }).error)
        : "internal";
    throw new ApiError(res.status, code);
  }
  return data as T;
}

export const api = {
  getVapid: () => call<VapidResponse>("GET", "/api/vapid"),
  createRoom: (keyHash: string) =>
    call<CreateRoomResponse>("POST", "/api/rooms", { body: { keyHash } }),
  join: (roomId: string, auth: string) =>
    call<JoinResponse>("POST", `/api/rooms/${roomId}/join`, {
      auth,
      body: {},
    }),
  listMessages: (roomId: string, auth: string, after: number, limit = 50) =>
    call<ListMessagesResponse>(
      "GET",
      `/api/rooms/${roomId}/messages?after=${after}&limit=${limit}`,
      { auth },
    ),
  postMessage: (
    roomId: string,
    auth: string,
    payload: { ts: number; kind: MessageKind; ct: string },
  ) =>
    call<PostMessageResponse>("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: payload,
    }),
  messageData: (roomId: string, auth: string, mid: number) =>
    call<MessageDataResponse>(
      "GET",
      `/api/rooms/${roomId}/messages/${mid}/data`,
      { auth },
    ),
  subscribe: (roomId: string, auth: string, sub: SubscribeRequest) =>
    call<void>("PUT", `/api/rooms/${roomId}/subscription`, {
      auth,
      body: sub,
    }),
  unsubscribe: (roomId: string, auth: string, endpoint: string) =>
    call<void>("DELETE", `/api/rooms/${roomId}/subscription`, {
      auth,
      body: { endpoint },
    }),
};
