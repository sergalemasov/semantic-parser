import { ControlDescriptor, ControlHandler, ParserOptions, UiControlNode, UiNode, UiRoot, UiSnapshot, UiTreeNode } from './contracts';

const SEMANTIC_TAGS = new Set([
  'article', 'aside', 'blockquote', 'details', 'dialog', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'header', 'li', 'main', 'nav', 'ol', 'section', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
]);
const NATIVE_CONTROLS = new Set(['button', 'input', 'select', 'textarea', 'a']);
const CLICKABLE_ROLES = new Set(['button', 'checkbox', 'link', 'menuitem', 'option', 'radio', 'switch', 'tab', 'treeitem']);
const CLICKABLE_ATTRIBUTES = ['onclick', 'data-action', 'data-click', 'data-testid', 'ng-click', '(click)'];
const DEFAULT_CONTEXT_ATTRIBUTES = ['data-testid', 'data-qa', 'formcontrolname', 'name', 'title'];

export class DomIdentityStore {
  private readonly ids = new WeakMap<Element, string>();

  idFor(element: Element, prefix = 'node'): string {
    const existing = this.ids.get(element);
    if (existing) return existing;

    const id = `${prefix}_${crypto.randomUUID()}`;
    this.ids.set(element, id);
    return id;
  }
}

export class ControlRegistry {
  constructor(private readonly handlers: ControlHandler[] = []) {}

  find(element: HTMLElement): ControlHandler | undefined {
    return this.handlers.find((handler) => handler.matches(element));
  }
}

export class DomSnapshotParser {
  constructor(
    private readonly registry: ControlRegistry,
    readonly identities = new DomIdentityStore(),
    private readonly options: ParserOptions = {}
  ) {}

  parse(roots: UiRoot[]): UiSnapshot {
    return { version: 1, __capturedAt: new Date().toISOString(), roots };
  }

  parseRoot(element: HTMLElement, root: Omit<UiRoot, 'tree'>): UiRoot {
    return { ...root, tree: this.parseChildren(element) };
  }

  elementFor(controlId: string, root: ParentNode): HTMLElement | undefined {
    return Array.from(root.querySelectorAll<HTMLElement>('*')).find((element) => {
      const prefix = this.prefixFor(element);
      return prefix !== undefined && this.identities.idFor(element, prefix) === controlId;
    });
  }

  private parseChildren(parent: ParentNode): UiTreeNode[] {
    const nodes: UiTreeNode[] = [];
    parent.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = this.normalizeText(child.textContent ?? '');
        if (text) this.appendNode(nodes, { text });
        return;
      }
      if (child instanceof HTMLElement) {
        const parsed = this.parseElement(child);
        parsed?.forEach((node) => this.appendNode(nodes, node));
      }
    });
    return nodes;
  }

  private parseElement(element: HTMLElement): UiTreeNode[] | undefined {
    if (this.isHidden(element)) return undefined;

    const handler = this.registry.find(element);
    if (handler) return [this.controlNode(element, handler)];

    const children = this.parseChildren(element);
    if (this.isPotentiallyClickable(element)) {
      return [{
        id: this.identities.idFor(element, 'unhandled'), __xpath: this.xpathOf(element), domId: this.domIdOf(element),
        tag: element.localName, role: element.getAttribute('role') ?? undefined, label: this.controlName(element),
        context: this.contextOf(element), relations: this.relationsOf(element), children
      }];
    }

    if (this.isSemantic(element)) {
      return [{
        domId: this.domIdOf(element), tag: element.localName,
        role: element.getAttribute('role') ?? undefined,
        label: this.hasInteractiveRole(element) ? this.controlName(element) : this.containerName(element),
        context: this.contextOf(element), relations: this.relationsOf(element), children
      }];
    }

    if (this.isMeaningfulGroup(element, children)) {
      return [{
        domId: this.domIdOf(element), tag: element.localName, label: this.containerName(element),
        context: this.contextOf(element), relations: this.relationsOf(element), children
      }];
    }

    // Presentation-only wrappers with at most one parsed child do not consume tokens.
    return children;
  }

  private controlNode(element: HTMLElement, handler: ControlHandler): UiControlNode {
    const id = this.identities.idFor(element, 'control');
    const { context: handlerContext, ...control } = handler.parse(element);
    return {
      id, __xpath: this.xpathOf(element), domId: this.domIdOf(element), tag: element.localName, label: this.controlName(element),
      description: this.controlDescription(element),
      context: this.mergeContext(this.contextOf(element), handlerContext), relations: this.relationsOf(element), control,
      children: control.__atomic ? undefined : this.parseChildren(element)
    };
  }

  private controlName(element: HTMLElement): string | undefined {
    return this.referencedText(element, 'aria-labelledby') ||
      this.attributeText(element, 'aria-label') || this.nativeLabelText(element) ||
      this.normalizeText(this.visibleTextOf(element)) || this.attributeText(element, 'title');
  }

  private controlDescription(element: HTMLElement): string | undefined {
    return this.referencedText(element, 'aria-describedby') || this.attributeText(element, 'aria-description');
  }

  private nativeLabelText(element: HTMLElement): string | undefined {
    if (!(element instanceof HTMLButtonElement || element instanceof HTMLInputElement ||
      element instanceof HTMLMeterElement || element instanceof HTMLOutputElement ||
      element instanceof HTMLProgressElement || element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement)) return undefined;

    const text = Array.from(element.labels ?? []).map((label) => this.visibleTextOf(label)).join(' ');
    return this.normalizeText(text) || undefined;
  }

  private attributeText(element: HTMLElement, attribute: string): string | undefined {
    return this.normalizeText(element.getAttribute(attribute) ?? '') || undefined;
  }

  private containerName(element: HTMLElement): string | undefined {
    const labelledBy = this.referencedText(element, 'aria-labelledby');
    if (labelledBy) return labelledBy;
    const ariaLabel = this.normalizeText(element.getAttribute('aria-label') ?? '');
    if (ariaLabel) return ariaLabel;
    return this.intrinsicContainerName(element);
  }

  private intrinsicContainerName(element: HTMLElement): string | undefined {
    const labelTag = element.localName === 'table' ? 'caption' :
      element.localName === 'fieldset' ? 'legend' :
      element.localName === 'figure' ? 'figcaption' :
      element.localName === 'details' ? 'summary' : undefined;
    if (!labelTag) return undefined;
    const labelElement = Array.from(element.children).find((child) => child.localName === labelTag);
    return labelElement instanceof HTMLElement ? this.normalizeText(this.visibleTextOf(labelElement)) || undefined : undefined;
  }

  private relationsOf(element: HTMLElement): UiNode['relations'] {
    const labelledBy = this.relationOf(element, 'aria-labelledby', 'labelledby');
    const controls = this.relationOf(element, 'aria-controls', 'controls');
    const relations = [labelledBy, controls].filter((relation) => relation !== undefined);
    return relations.length ? relations : undefined;
  }

  private relationOf(
    element: HTMLElement,
    attribute: 'aria-labelledby' | 'aria-controls',
    type: 'labelledby' | 'controls'
  ): UiNode['relations'] extends Array<infer Relation> | undefined ? Relation | undefined : never {
    const targetDomIds = this.referencedIds(element, attribute);
    if (!targetDomIds.length) return undefined;
    return { type, targetDomIds };
  }

  private referencedText(element: HTMLElement, attribute: 'aria-labelledby' | 'aria-describedby'): string | undefined {
    const texts = this.referencedIds(element, attribute).flatMap((id) => {
      const target = this.elementByDomId(element, id);
      const text = target ? this.normalizeText(this.visibleTextOf(target)) : '';
      return text ? [text] : [];
    });
    return texts.length ? texts.join(' ') : undefined;
  }

  private referencedIds(element: HTMLElement, attribute: 'aria-labelledby' | 'aria-describedby' | 'aria-controls'): string[] {
    return (element.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean);
  }

  private elementByDomId(element: HTMLElement, id: string): HTMLElement | undefined {
    const root = element.getRootNode() as Document | DocumentFragment;
    if (root instanceof Document) return root.getElementById(id) ?? undefined;
    return Array.from(root.querySelectorAll<HTMLElement>('[id]')).find((candidate) => candidate.id === id);
  }

  private contextOf(element: HTMLElement): Record<string, unknown> | undefined {
    const names = this.options.contextAttributes ?? DEFAULT_CONTEXT_ATTRIBUTES;
    const context = Object.fromEntries(names.flatMap((name) => {
      const value = element.getAttribute(name);
      if (!value) return [];
      const key = name === 'aria-expanded' ? 'expanded' : name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return [[key, name === 'aria-expanded' ? value === 'true' : value]];
    }));
    return Object.keys(context).length ? context : undefined;
  }

  private mergeContext(
    attributeContext: Record<string, unknown> | undefined,
    handlerContext: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    const context = { ...attributeContext, ...handlerContext };
    return Object.keys(context).length ? context : undefined;
  }

  private isSemantic(element: HTMLElement): boolean {
    return SEMANTIC_TAGS.has(element.localName) || element.hasAttribute('role') ||
      element.id !== '' ||
      element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby') ||
      element.hasAttribute('aria-description');
  }

  private domIdOf(element: HTMLElement): string | undefined {
    return element.id || undefined;
  }

  private xpathOf(element: HTMLElement): string {
    const segments: string[] = [];
    let current: Element | null = element;

    while (current) {
      const currentElement: Element = current;
      const siblings: Element[] = currentElement.parentElement
        ? Array.from(currentElement.parentElement.children).filter((sibling) => sibling.localName === currentElement.localName)
        : [currentElement];
      const index = siblings.indexOf(currentElement) + 1;
      segments.unshift(`${currentElement.localName}[${index}]`);
      current = currentElement.parentElement;
    }

    return `/${segments.join('/')}`;
  }

  private isPotentiallyClickable(element: HTMLElement): boolean {
    if (element.matches(':disabled, [aria-disabled="true"]')) return false;
    if (NATIVE_CONTROLS.has(element.localName)) return true;

    const role = element.getAttribute('role');
    if (role && CLICKABLE_ROLES.has(role)) return true;
    if (CLICKABLE_ATTRIBUTES.some((attribute) => element.hasAttribute(attribute))) return true;
    if (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false') return true;
    if (element.tabIndex >= 0 && element.localName !== 'div' && element.localName !== 'span') return true;

    return getComputedStyle(element).cursor === 'pointer';
  }

  private hasInteractiveRole(element: HTMLElement): boolean {
    const role = element.getAttribute('role');
    return role !== null && CLICKABLE_ROLES.has(role);
  }

  private isMeaningfulGroup(element: HTMLElement, children: UiTreeNode[]): boolean {
    return (element.localName === 'div' || element.localName === 'span') && children.length > 1;
  }

  private isHidden(element: HTMLElement): boolean {
    return element.hidden || element.getAttribute('aria-hidden') === 'true' ||
      element.closest('[data-parser-ignore]') !== null;
  }

  private visibleTextOf(element: HTMLElement): string {
    const texts: string[] = [];
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
      const parent = textNode.parentElement;
      if (parent && !this.isHidden(parent)) texts.push(textNode.textContent ?? '');
      textNode = walker.nextNode();
    }
    return texts.join(' ');
  }

  private normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  private appendNode(nodes: UiTreeNode[], node: UiTreeNode): void {
    const previous = nodes[nodes.length - 1];
    if (this.isTextNode(previous) && this.isTextNode(node)) {
      previous.text = `${previous.text ?? ''} ${node.text ?? ''}`.trim();
      return;
    }
    nodes.push(node);
  }

  private isTextNode(node: UiTreeNode | undefined): node is UiNode {
    return node !== undefined && node.text !== undefined && node.tag === undefined && !('control' in node) && !('id' in node);
  }

  private prefixFor(element: HTMLElement): 'control' | 'unhandled' | undefined {
    if (this.registry.find(element)) return 'control';
    return this.isPotentiallyClickable(element) ? 'unhandled' : undefined;
  }
}