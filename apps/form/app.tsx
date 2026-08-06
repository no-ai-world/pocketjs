// 官方桌面表单 demo：通用 TextInput + 焦点分离 + companion 分渠。

import { createSignal, Show } from "solid-js";
import { Text, TextInput, Focusable, Screen, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import {
  connectCompanion,
  connectHostInput,
  installHostInputPump,
} from "@pocketjs/framework/input";
import { hasFeature } from "@pocketjs/framework/platform";

export default function Form() {
  // Render the generic desktop form and its host/companion channels.
  installHostInputPump();

  const canEdit = hasFeature("input.text");
  const [name, setName] = createSignal("");
  const [phone, setPhone] = createSignal("");
  const [note, setNote] = createSignal("");
  const [status, setStatus] = createSignal(canEdit ? "ready" : "read-only host");
  const [submitted, setSubmitted] = createSignal("");
  const [companionMsg, setCompanionMsg] = createSignal("");

  const companion = connectCompanion();
  const shell = connectHostInput();

  onFrame(() => {
    if (shell) {
      for (const ev of shell.poll()) {
        if (ev.t === "hello") {
          setStatus(`shell ${ev.w}x${ev.h}`);
        } else if (ev.t === "companion_offline") {
          setCompanionMsg("companion offline");
        }
      }
    }
    if (!companion) return;
    for (const raw of companion.poll()) {
      if (!raw || typeof raw !== "object") continue;
      const ev = raw as { t?: string; text?: string; protocol?: string; host?: string };
      // 业务 hello{protocol,host} 与壳 hello{w,h} 已分渠
      if (ev.t === "hello" && (ev.protocol || ev.host)) {
        setCompanionMsg(`companion hello ${ev.protocol ?? ""} ${ev.host ?? ""}`.trim());
        continue;
      }
      if (ev.t === "status" && ev.text) {
        setCompanionMsg(ev.text);
      }
    }
  });

  const submit = () => {
    const line = `${name().trim()} · ${phone().trim()} · ${note().trim()}`;
    setSubmitted(line);
    setStatus("submitted");
    companion?.send({ t: "submit", name: name(), phone: phone(), note: note() });
  };

  return (
    <Screen class="flex-col w-full h-full p-4 gap-3 bg-slate-100">
      <Text class="text-xl text-slate-800 font-bold">Pocket Form</Text>
      <Text class="text-xs text-slate-500">
        {"TextInput - editable focus - shell/companion split"}
      </Text>

      <View class="flex-col gap-1">
        <Text class="text-xs text-slate-600">Name</Text>
        <Show
          when={canEdit}
          fallback={<Text class="text-sm text-slate-400">input.text unavailable</Text>}
        >
          <TextInput
            value={name()}
            onChange={setName}
            onSubmit={submit}
            placeholder="Your name"
            maxWidth={280}
            class="relative flex-row items-center h-[32] px-2 rounded-md bg-white border-slate-300 focus:border-indigo-500"
          />
        </Show>
      </View>

      <View class="flex-col gap-1">
        <Text class="text-xs text-slate-600">电话 Telephone</Text>
        <Show
          when={canEdit}
          fallback={<Text class="text-sm text-slate-400">input.text unavailable</Text>}
        >
          <TextInput
            value={phone()}
            onChange={setPhone}
            onSubmit={submit}
            placeholder="手机号码"
            maxWidth={280}
            class="relative flex-row items-center h-[32] px-2 rounded-md bg-white border-slate-300 focus:border-indigo-500"
          />
        </Show>
      </View>

      <View class="flex-col gap-1">
        <Text class="text-xs text-slate-600">备注</Text>
        <Show when={canEdit}>
          <TextInput
            value={note()}
            onChange={setNote}
            multiline
            placeholder="Multiline note…"
            maxWidth={280}
            lineHeight={20}
            class="relative flex-row items-start min-h-[72] px-2 py-1 rounded-md bg-white border-slate-300 focus:border-indigo-500"
          />
        </Show>
      </View>

      <View class="flex-row gap-2">
        <Focusable
          onPress={submit}
          class="px-3 py-1 rounded-md bg-indigo-600 focus:bg-indigo-700"
        >
          <Text class="text-sm text-white">Submit</Text>
        </Focusable>
        <Focusable
          onPress={() => {
            setName("");
            setNote("");
            setSubmitted("");
            setStatus("cleared");
          }}
          class="px-3 py-1 rounded-md bg-slate-200 focus:bg-slate-300"
        >
          <Text class="text-sm text-slate-800">Clear</Text>
        </Focusable>
      </View>

      <Text class="text-xs text-slate-600">status: {status()}</Text>
      <Show when={submitted()}>
        <Text class="text-sm text-slate-800">last: {submitted()}</Text>
      </Show>
      <Show when={companionMsg()}>
        <Text class="text-xs text-emerald-700">{companionMsg()}</Text>
      </Show>
    </Screen>
  );
}
