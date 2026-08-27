import { ControlHandler, UiControlNode, UiTreeNode } from './contracts';
import { ControlRegistry, DomSnapshotParser } from './dom-snapshot-parser';

const isControl = (node: UiTreeNode | undefined): node is UiControlNode => node !== undefined && 'control' in node;

describe('DomSnapshotParser', () => {
  const buttonHandler: ControlHandler = {
    type: 'button',
    matches: (element) => element.matches('button'),
     parse: () => ({ __atomic: true, type: 'button', tools: [{ id: 'activate', type: 'click' }] })
  };

  it('retains controls in table cells and preserves a multi-node wrapper container', () => {
    const host = document.createElement('div');
    host.innerHTML = '<table><caption>Invoices</caption><tbody><tr><td><div>Invoice <button>Open</button></div></td></tr></tbody></table>';
    const parser = new DomSnapshotParser(new ControlRegistry([buttonHandler]));

    const result = parser.parseRoot(host, { id: 'root-invoices' });
    const json = JSON.stringify(result.tree);

    expect(json).toContain('Invoice');
    expect(json).toContain('"type":"button"');
    expect(json).toContain('"tag":"div"');
    expect(result.tree[0].label).toBe('Invoices');
  });

  it('does not descend into a registered atomic control', () => {
    const host = document.createElement('div');
    host.innerHTML = '<section><div class="calendar"><button>Internal day</button></div></section>';
    const calendarHandler: ControlHandler = {
      type: 'calendar', matches: (element) => element.classList.contains('calendar'),
      parse: () => ({ __atomic: true, type: 'calendar', value: null, tools: [{ id: 'open', type: 'click' }] })
    };
    const parser = new DomSnapshotParser(new ControlRegistry([calendarHandler, buttonHandler]));

    const result = parser.parseRoot(host, { id: 'root-form' });
    const calendar = result.tree[0].children?.[0];

    expect(isControl(calendar) ? calendar.control.type : undefined).toBe('calendar');
    expect(calendar?.children).toBeUndefined();
  });

  it('retains a div that aggregates multiple direct controls', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div><button>Save</button><button>Cancel</button></div>';
    const parser = new DomSnapshotParser(new ControlRegistry([buttonHandler]));

    const result = parser.parseRoot(host, { id: 'root-actions' });

    expect(result.tree[0]).toEqual(jasmine.objectContaining({ tag: 'div' }));
    expect(result.tree[0].children?.map((node) => isControl(node) ? node.control.type : undefined)).toEqual(['button', 'button']);
  });

  it('flattens a neutral div with one child', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div><button>Pay</button></div>';
    const parser = new DomSnapshotParser(new ControlRegistry([buttonHandler]));

    const result = parser.parseRoot(host, { id: 'root-billing' });

    expect(result.tree[0]).toEqual(jasmine.objectContaining({ control: jasmine.any(Object) }));
    expect(result.tree[0].tag).toBe('button');
  });

  it('exposes an unregistered click-like div as unhandled', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div data-action="open-invoice" tabindex="0">Open invoice</div>';
    const parser = new DomSnapshotParser(new ControlRegistry());

    const result = parser.parseRoot(host, { id: 'root-invoices' });

    expect(result.tree[0]).toEqual(jasmine.objectContaining({
      tag: 'div', label: 'Open invoice', __xpath: '/div[1]/div[1]'
    }));
  });

  it('does not expose a disabled heuristic control as unhandled', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div role="button" aria-disabled="true">Disabled action</div>';
    const parser = new DomSnapshotParser(new ControlRegistry());

    const result = parser.parseRoot(host, { id: 'root-actions' });

    expect(result.tree[0]).toEqual(jasmine.objectContaining({
      tag: 'div', role: 'button', label: 'Disabled action'
    }));
  });

  it('resolves a multi-node aria-labelledby reference into a group label', () => {
    const host = document.createElement('div');
    host.innerHTML = '<span id="customer">Customer</span><span id="number">#184</span><div aria-labelledby="customer number"><button>Open</button></div>';
    const parser = new DomSnapshotParser(new ControlRegistry([buttonHandler]));

    const result = parser.parseRoot(host, { id: 'root-invoices' });
    const group = result.tree[2];

    expect(result.tree[0]).toEqual(jasmine.objectContaining({ domId: 'customer' }));
    expect(result.tree[1]).toEqual(jasmine.objectContaining({ domId: 'number' }));
    expect(group).toEqual(jasmine.objectContaining({ label: 'Customer #184' }));
    expect(group.relations).toEqual([{ type: 'labelledby', targetDomIds: ['customer', 'number'] }]);
  });

  it('uses accessible-name precedence and keeps the description separate', () => {
    const host = document.createElement('div');
    host.innerHTML = '<span id="external-name">External name</span><span id="hint">Irreversible action</span><label for="save">Native label</label><button id="save" aria-labelledby="external-name" aria-label="ARIA label" aria-describedby="hint" aria-description="ARIA description">Visible text</button>';
    const parser = new DomSnapshotParser(new ControlRegistry([buttonHandler]));

    const result = parser.parseRoot(host, { id: 'root-actions' });
    const button = result.tree.find(isControl);

    expect(button).toEqual(jasmine.objectContaining({
      label: 'External name', description: 'Irreversible action'
    }));
  });

  it('uses aria-label before a native label and visible control text', () => {
    const host = document.createElement('div');
    host.innerHTML = '<label for="save">Native label</label><button id="save" aria-label="ARIA label">Visible text</button>';
    const parser = new DomSnapshotParser(new ControlRegistry([buttonHandler]));

    const result = parser.parseRoot(host, { id: 'root-actions' });

    expect(result.tree[1]).toEqual(jasmine.objectContaining({ label: 'ARIA label' }));
  });

  it('retains aria-controls as a cross-root relation on its trigger', () => {
    const host = document.createElement('div');
    host.innerHTML = '<button aria-controls="invoice-menu" aria-expanded="false">Actions</button>';
    const parser = new DomSnapshotParser(new ControlRegistry([buttonHandler]), undefined, { contextAttributes: ['aria-expanded'] });

    const result = parser.parseRoot(host, { id: 'root-invoices' });

    expect(result.tree[0].relations).toEqual([{ type: 'controls', targetDomIds: ['invoice-menu'] }]);
    expect(result.tree[0].context).toEqual({ expanded: false });
  });

  it('merges configured attribute context with typed handler context', () => {
    const host = document.createElement('div');
    host.innerHTML = '<button data-screen="invoices">Open</button>';
    const contextualHandler: ControlHandler = {
      ...buttonHandler,
      parse: () => ({ __atomic: true, type: 'button', context: { actionScope: 'invoice' }, tools: [{ id: 'activate', type: 'click' }] })
    };
    const parser = new DomSnapshotParser(new ControlRegistry([contextualHandler]), undefined, { contextAttributes: ['data-screen'] });

    const result = parser.parseRoot(host, { id: 'root-invoices' });

    expect(result.tree[0].context).toEqual({ screen: 'invoices', actionScope: 'invoice' });
  });

  it('excludes a data-parser-ignore subtree from the snapshot', () => {
    const host = document.createElement('div');
    host.innerHTML = '<button>Save</button><pre data-parser-ignore>Debug snapshot</pre>';
    const parser = new DomSnapshotParser(new ControlRegistry([buttonHandler]));

    const result = parser.parseRoot(host, { id: 'root-form' });

    expect(result.tree).toHaveSize(1);
    expect(isControl(result.tree[0]) ? result.tree[0].control.type : undefined).toBe('button');
    expect(isControl(result.tree[0]) ? result.tree[0].__xpath : undefined).toBe('/div[1]/button[1]');
  });

  it('excludes ignored subtree text from a semantic ancestor label', () => {
    const host = document.createElement('div');
    host.innerHTML = '<article><p>Visible invoice</p><pre data-parser-ignore>{"debug":true}</pre></article>';
    const parser = new DomSnapshotParser(new ControlRegistry());

    const result = parser.parseRoot(host, { id: 'root-invoices' });

    expect(result.tree[0]).toEqual(jasmine.objectContaining({ tag: 'article' }));
    expect(result.tree[0].label).toBeUndefined();
    expect(JSON.stringify(result.tree)).not.toContain('debug');
  });

  it('keeps ids only on interactive nodes and merges text inside a heuristic container', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div>Invoice <span>#184</span> is due <button>Pay</button></div>';
    const parser = new DomSnapshotParser(new ControlRegistry([buttonHandler]));

    const result = parser.parseRoot(host, { id: 'root-invoice' });

    expect(result.tree).toEqual([
      jasmine.objectContaining({
        tag: 'div',
        children: [
          { text: 'Invoice #184 is due' },
          jasmine.objectContaining({ id: jasmine.any(String), control: jasmine.any(Object) })
        ]
      })
    ]);
  });
});