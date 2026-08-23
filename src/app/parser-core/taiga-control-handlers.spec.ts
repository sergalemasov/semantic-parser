import { UiEvent } from './contracts';
import { ControlRegistry } from './dom-snapshot-parser';
import { taigaControlHandlers } from './taiga-control-handlers';

describe('Taiga control handlers', () => {
  const event = (toolId: string, value?: string): UiEvent => ({
     __eventId: 'event-1', __occurredAt: '2026-08-23T00:00:00.000Z', rootId: 'root-1',
     controlId: 'control-1', type: 'input', toolId, value, __source: 'llm'
  });

  it('sets a tuiInput value through its input event', () => {
    const input = document.createElement('input');
    input.setAttribute('tuiInput', '');
    const listener = jasmine.createSpy('input');
    input.addEventListener('input', listener);

    new ControlRegistry(taigaControlHandlers).find(input)?.dispatch?.(input, event('set-value', 'Ada'));

    expect(input.value).toBe('Ada');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('exposes opening rather than arbitrary value assignment for tuiSelect input', () => {
    const input = document.createElement('input');
    input.setAttribute('tuiSelect', '');
    const handler = new ControlRegistry(taigaControlHandlers).find(input)!;
    const listener = jasmine.createSpy('click');
    input.addEventListener('click', listener);

    handler.dispatch?.(input, event('open-menu'));

    expect(handler.parse(input).tools).toEqual([
      { id: 'open-menu', type: 'click' }, { id: 'clear', type: 'input' }
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('sets a native tuiSelect by value and emits change', () => {
    const select = document.createElement('select');
    select.setAttribute('tuiSelect', '');
    select.innerHTML = '<option value="ios">iOS</option><option value="android">Android</option>';
    const listener = jasmine.createSpy('change');
    select.addEventListener('change', listener);

    new ControlRegistry(taigaControlHandlers).find(select)?.dispatch?.(select, event('set-value', 'android'));

    expect(select.value).toBe('android');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});