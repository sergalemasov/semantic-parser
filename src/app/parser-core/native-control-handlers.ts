import { ControlHandler } from './contracts';

export const nativeControlHandlers: ControlHandler[] = [
  {
    type: 'button',
    matches: (element) => element.matches('button, [role="button"]'),
    parse: () => ({ __atomic: true, type: 'button', tools: [{ id: 'activate', type: 'click' }] }),
    dispatch: (element, event) => {
      if (event.type === 'click') element.click();
    }
  },
  {
    type: 'input',
    matches: (element) => element.matches('input, textarea, select'),
    parse: (element) => ({
      __atomic: true,
      type: element.localName === 'select' ? 'select' : 'input',
      value: element instanceof HTMLInputElement && element.type === 'checkbox'
        ? element.checked : (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value,
      tools: [{ id: 'set-value', type: 'input' }]
    }),
    dispatch: (element, event) => {
      if (event.value !== undefined && 'value' in element) {
        (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value = String(event.value ?? '');
      }
      element.dispatchEvent(new Event(event.type === 'change' ? 'change' : 'input', { bubbles: true }));
    }
  }
];