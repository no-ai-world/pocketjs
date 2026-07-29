// apps/note/svc.ts — note 壳协议，转发到框架 host-input。

import {
  connectNoteHost,
  type HostInputEvent,
} from "@pocketjs/framework/input";

export type HostEvent = HostInputEvent;

export interface Svc {
  poll(): HostEvent[];
  send(
    line:
      | { t: "save"; text: string }
      | { t: "quit" }
      | { t: "menu"; open: boolean }
      | { t: "copy"; text: string }
      | { t: "caret"; x: number; y: number; h: number },
  ): void;
}

/** Probe the channel; null = standalone (no widget host on the other end). */
export function connectSvc(): Svc | null {
  const host = connectNoteHost();
  if (!host) return null;
  return {
    poll: () => host.poll(),
    send: (line) => host.send(line),
  };
}
