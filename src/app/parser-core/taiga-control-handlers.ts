import { ControlHandler, UiEvent } from './contracts';

const setNativeValue = (element: HTMLInputElement | HTMLSelectElement, value: string): void => {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
};

const emit = (element: HTMLElement, type: 'input' | 'change'): void => {
  element.dispatchEvent(new Event(type, { bubbles: true }));
};

const dispatchInput = (element: HTMLInputElement, event: UiEvent): void => {
  if (event.toolId !== 'set-value' || event.value === undefined) return;
  setNativeValue(element, String(event.value ?? ''));
  emit(element, 'input');
};

const tuiInputHandler: ControlHandler = {
  type: 'tui-input',
  matches: (element) => element.matches('input[tuiInput]:not([tuiSelect])'),
  parse: (element) => ({
    __atomic: true,
    type: 'tui-input',
    value: (element as HTMLInputElement).value,
    tools: [{ id: 'set-value', type: 'input' }]
  }),
  dispatch: (element, event) => dispatchInput(element as HTMLInputElement, event)
};

const tuiSelectHandler: ControlHandler = {
  type: 'tui-select',
  matches: (element) => element.matches('input[tuiSelect], select[tuiSelect]'),
  parse: (element) => {
    const native = element instanceof HTMLSelectElement;
    return {
      __atomic: true,
      type: native ? 'tui-native-select' : 'tui-select',
      value: native ? element.value : (element as HTMLInputElement).value,
      tools: native
        ? [{ id: 'set-value', type: 'select' }]
        : [{ id: 'open-menu', type: 'click' }, { id: 'clear', type: 'input' }]
    };
  },
  dispatch: (element, event) => {
    if (element instanceof HTMLSelectElement && event.toolId === 'set-value' && event.value !== undefined) {
      setNativeValue(element, String(event.value));
      emit(element, 'change');
      return;
    }
    if (element instanceof HTMLInputElement && event.toolId === 'open-menu') {
      element.click();
      return;
    }
    if (element instanceof HTMLInputElement && event.toolId === 'clear') {
      dispatchInput(element, { ...event, toolId: 'set-value', value: '' });
    }
  }
};

export const taigaControlHandlers: ControlHandler[] = [tuiSelectHandler, tuiInputHandler];