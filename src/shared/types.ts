/** API・CBORメッセージの型定義（設計 §5 / §6.2） */

export type MessageKind = "text" | "image";

/** CBOR レイヤーの型（暗号化される全体、設計 §6.2） */
export interface WireHeader {
  v: 1;
  id: string; // メッセージUUID（サーバには渡らない）
  kind: MessageKind;
  name: string; // 1〜20文字
  ts: number; // 送信者タイムスタンプ ms
}

export interface TextWireMessage extends WireHeader {
  kind: "text";
  body: string; // 1〜400文字
}

export interface ImageWireMessage extends WireHeader {
  kind: "image";
  body: {
    d: string; // base64画像（96KB相当以下）
    m: "image/webp";
    n: string; // ファイル名 1〜64文字
  };
}

export type WireMessage = TextWireMessage | ImageWireMessage;

/** API DTO（設計 §5） */
export interface CreateRoomRequest {
  keyHash: string; // hex64
}
export interface CreateRoomResponse {
  roomId: string;
}
export interface JoinResponse {
  ok: true;
}
export interface MessageDto {
  id: number;
  ts: number;
  kind: MessageKind;
  /** text のみ同梱（base64 の IV‖暗号文‖tag） */
  ct?: string;
}
export interface ListMessagesResponse {
  messages: MessageDto[];
}
export interface PostMessageRequest {
  ts: number;
  kind: MessageKind;
  ct: string; // base64
}
export interface PostMessageResponse {
  id: number;
}
export interface MessageDataResponse {
  ct: string; // base64（チャンク結合済み）
}
export interface SubscribeRequest {
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface VapidResponse {
  publicKey: string;
}
export interface ApiErrorBody {
  error: string;
}

/** push ペイロード（設計 §6.5。平文JSON、ct は任意） */
export interface PushPayload {
  v: 1;
  roomId: string;
  id: number;
  ts: number;
  kind: MessageKind;
  ct?: string;
}
