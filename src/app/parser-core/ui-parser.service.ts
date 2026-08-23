import { Injectable, signal } from '@angular/core';
import { ControlHandler, UiEvent, UiRoot, UiSnapshot } from './contracts';
import { ControlRegistry, DomSnapshotParser } from './dom-snapshot-parser';
import { nativeControlHandlers } from './native-control-handlers';

export interface ParserRoot {
  id: string;
  kind: UiRoot['kind'];
  element: HTMLElement;
  name?: string;
  ignored?: (mutation: MutationRecord) => boolean;
}

@Injectable({ providedIn: 'root' })
export class UiParserService {
  readonly snapshot = signal<UiSnapshot>({ version: 1, __capturedAt: '', roots: [] });
  readonly lastEvent = signal<UiEvent | undefined>(undefined);
  private handlers: ControlHandler[] = [...nativeControlHandlers];
  private registry = new ControlRegistry(this.handlers);
  private parser = new DomSnapshotParser(this.registry);
  private readonly roots = new Map<string, ParserRoot>();
  private observer?: MutationObserver;
  private scheduled = false;

  registerHandler(handler: ControlHandler): void {
    // Specialized component handlers take precedence over generic native controls.
    this.handlers = [handler, ...this.handlers];
    this.registry = new ControlRegistry(this.handlers);
    this.parser = new DomSnapshotParser(this.registry, this.parser.identities);
  }

  registerRoot(root: ParserRoot): () => void {
    this.roots.set(root.id, root);
    root.element.addEventListener('click', this.captureEvent, true);
    root.element.addEventListener('input', this.captureEvent, true);
    root.element.addEventListener('change', this.captureEvent, true);
    this.observe();
    this.refresh();
    return () => {
      root.element.removeEventListener('click', this.captureEvent, true);
      root.element.removeEventListener('input', this.captureEvent, true);
      root.element.removeEventListener('change', this.captureEvent, true);
      this.roots.delete(root.id);
      this.refresh();
    };
  }

  refresh(): void {
    const roots = [...this.roots.values()].map(({ element, ignored: _ignored, ...root }) =>
      this.parser.parseRoot(element, root)
    );
    this.snapshot.set(this.parser.parse(roots));
  }

  inspect(element: HTMLElement, root: Omit<UiRoot, 'tree'>): UiRoot {
    return this.parser.parseRoot(element, root);
  }

  dispatch(event: UiEvent): boolean {
    const root = this.roots.get(event.rootId);
    if (!root) return false;
    const element = this.parser.elementFor(event.controlId, root.element);
    if (!element) return false;
    const handler = this.registry.find(element);
    if (handler?.dispatch) handler.dispatch(element, { ...event, __source: 'llm' });
    else element.dispatchEvent(new Event(event.type, { bubbles: true }));
    this.refresh();
    return true;
  }

  private observe(): void {
    if (this.observer) return;
    this.observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => {
        if (this.isParserIgnoredMutation(mutation)) return false;
        const root = [...this.roots.values()].find(({ element }) => element.contains(mutation.target));
        return root && !root.ignored?.(mutation);
      });
      if (relevant) this.scheduleRefresh();
    });
    this.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }

  private isParserIgnoredMutation(mutation: MutationRecord): boolean {
    const element = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
    return element?.closest('[data-parser-ignore]') !== null;
  }

  private readonly captureEvent = (domEvent: Event): void => {
    const target = domEvent.target instanceof Element ? domEvent.target.closest<HTMLElement>('*') : null;
    if (!target) return;
    const root = [...this.roots.values()].find(({ element }) => element.contains(target));
    if (!root) return;
    const control = target.closest<HTMLElement>('button, input, textarea, select, [role="button"]');
    if (!control) return;
    const controlId = this.parser.identities.idFor(control, this.registry.find(control) ? 'control' : 'unhandled');
    const value = control instanceof HTMLInputElement && control.type === 'checkbox'
      ? control.checked : 'value' in control ? String((control as HTMLInputElement).value) : undefined;
    this.lastEvent.set({
      __eventId: crypto.randomUUID(), __occurredAt: new Date().toISOString(), rootId: root.id, controlId,
      type: domEvent.type as UiEvent['type'], value, __source: 'user'
    });
    this.scheduleRefresh();
  };

  private scheduleRefresh(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.refresh();
    });
  }
}