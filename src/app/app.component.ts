import { AfterViewInit, Component, ElementRef, ViewChild, inject } from '@angular/core';
import { JsonPipe, NgIf } from '@angular/common';
import { Check, Copy, LucideAngularModule } from 'lucide-angular';
import { UiEvent } from './parser-core/contracts';
import { UiParserService } from './parser-core/ui-parser.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [JsonPipe, LucideAngularModule, NgIf],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements AfterViewInit {
  @ViewChild('tabRoot') private tabRoot?: ElementRef<HTMLElement>;
  @ViewChild('popupRoot') private popupRoot?: ElementRef<HTMLElement>;
  @ViewChild('invoiceExample') private invoiceExample?: ElementRef<HTMLElement>;
  @ViewChild('expandExample') private expandExample?: ElementRef<HTMLElement>;
  @ViewChild('relationExample') private relationExample?: ElementRef<HTMLElement>;
  @ViewChild('labelledByExample') private labelledByExample?: ElementRef<HTMLElement>;
  @ViewChild('popupExample') private popupExample?: ElementRef<HTMLElement>;
  protected readonly parser = inject(UiParserService);
  protected readonly copyIcon = Copy;
  protected readonly checkIcon = Check;
  protected popupOpen = true;
  protected actionMessage = 'No LLM action dispatched.';
  protected copiedJson = '';
  protected invoiceJson = '';
  protected expandJson = '';
  protected relationJson = '';
  protected labelledByJson = '';
  protected popupJson = '';
  protected readonly invoiceHtml = `<table>
  <caption>Outstanding invoices</caption>
  <thead><tr><th>Customer</th><th>Amount</th><th>Action</th></tr></thead>
  <tbody><tr><td>Northstar</td><td>$2,400</td><td><button>Open</button></td></tr></tbody>
</table>`;
  protected readonly expandHtml = `<section class="expand-preview" aria-label="Payment details">
  <strong>Payment details <span>-</span></strong>
  <p>Due on 14 September. <button>Schedule reminder</button></p>
</section>`;
  protected readonly relationHtml = `<button
  aria-controls="invoice-menu"
  aria-expanded="false"
>
  Invoice actions
</button>

<!-- Separate portal root -->
<div id="invoice-menu" role="menu">...</div>`;
  protected readonly labelledByHtml = `<span id="invoice-customer">Northstar</span>
<span id="invoice-number">#184</span>

<section aria-labelledby="invoice-customer invoice-number">
  <p>Payment is due on 14 September.</p>
  <button>Open invoice</button>
</section>`;
  protected readonly popupHtml = `<div class="portal-preview">
  <span>Popup: invoice #184</span>
  <button>Send invoice</button>
  <button>Dismiss</button>
</div>`;

  ngAfterViewInit(): void {
    this.parser.registerRoot({ id: 'tab-invoices', name: 'Invoices', element: this.tabRoot!.nativeElement });
    this.parser.registerRoot({ id: 'popup-actions', name: 'Invoice actions', element: this.popupRoot!.nativeElement });
    this.invoiceJson = this.inspectExample(this.invoiceExample, 'example-invoice', 'Invoice list');
    this.expandJson = this.inspectExample(this.expandExample, 'example-expand', 'Payment details');
    this.relationJson = this.inspectExample(this.relationExample, 'example-controls', 'Popup trigger');
    this.labelledByJson = this.inspectExample(this.labelledByExample, 'example-labelledby', 'Invoice label');
    this.popupJson = this.inspectExample(this.popupExample, 'example-popup', 'Invoice actions');
  }

  protected dispatchLatest(): void {
    const event = this.parser.lastEvent();
    if (!event) return;
    const action: UiEvent = { ...event, __eventId: crypto.randomUUID(), __occurredAt: new Date().toISOString(), __source: 'llm' };
    this.actionMessage = this.parser.dispatch(action) ? `Replayed ${event.type} for ${event.controlId}.` : 'Control is no longer in this root.';
  }

  protected async copyJson(panel: string, json: string): Promise<void> {
    if (!(await this.copyText(json))) return;
    this.copiedJson = panel;
    window.setTimeout(() => {
      if (this.copiedJson === panel) this.copiedJson = '';
    }, 1600);
  }

  protected snapshotJson(): string {
    return JSON.stringify(this.parser.snapshot(), null, 2);
  }

  private inspectExample(element: ElementRef<HTMLElement> | undefined, id: string, name: string): string {
    if (!element) return '';
    return JSON.stringify(this.parser.inspect(element.nativeElement, { id, name }), null, 2);
  }

  private async copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    }
  }
}
