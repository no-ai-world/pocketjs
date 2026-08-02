// Input/focus public API.

export { BTN } from "../../contracts/spec/spec.ts";
export {
  pointerPosition,
  touches,
  type PointerPosition,
  type TouchContact,
} from "./touch.ts";
export {
  cursorX,
  cursorY,
  blurFocus,
  enableCursor,
  focusNode,
  getFocused,
  hitFocusable,
  isEditableFocused,
  moveFocusByTab,
  pushFocusController,
  pushFocusGrid,
  pushFocusScope,
  restoreFocus,
  type CursorOptions,
  type FocusDirection,
  type FocusGridOptions,
  type FocusScopeOptions,
} from "./input.ts";
export {
  connectCompanion,
  connectHostInput,
  connectNoteHost,
  ensureText,
  installHostInputPump,
  openHostChannel,
  registerEditable,
  type EditableHandler,
  type HostInputEvent,
} from "./host-input.ts";
