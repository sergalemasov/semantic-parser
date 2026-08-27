# RFC: Древовидный UI-парсер и протокол действий

**Статус:** предлагаемая эталонная реализация. Код в `src/app/parser-core` намеренно не зависит от фреймворка; Angular отвечает за жизненный цикл, root-узлы, наблюдение и обработчики, специфичные для Taiga UI.

## Контекст, проблема и объем

Плоский протокол `Widget[] / Control[]` теряет видимую пользователю иерархию и трактует контейнеры, например таблицу или expand из Taiga, как один жёстко заданный контрол. В результате контролы внутри ячеек исчезают, а раскрываемое содержимое становится неадресуемым текстом. DOM-first дерево должно сохранять семантику и одновременно позволять известным составным виджетам оставаться атомарными.

RFC определяет framework-agnostic контракт снимка, правила обхода DOM, расширения для Taiga UI, root-узлы и границу между каноническим снимком, backend и LLM. В него не входят стратегия долгоживущих идентификаторов, выбор компактного формата LLM и передача изменений снимка: эти решения вынесены в отдельные RFC.

## Цель

- Сохранять значимую HTML-семантику и вложенность списков/таблиц.
- Присваивать каждому узлу, с которым можно взаимодействовать, непрозрачный непоследовательный идентификатор `control_<uuid>`, пригодный для поиска в логах.
- Делать регистрацию обработчиков аддитивной, а решение об атомарности — ответственностью обработчика.
- Захватывать пользовательские события и воспроизводить выбранный LLM tool через тот же обработчик.
- Рассматривать вкладку, диалог, popup, уведомление и страницу как независимо адресуемые root-узлы.
- Оставлять неподдерживаемый интерактивный HTML видимым как `unhandled`, а не молча исключать его.

### Не входит в цель

- Восстановление UUID, существующих только во время работы страницы, после полного обновления браузера. Это опционально: если необходима идентичность между обновлениями, следует использовать принадлежащий продукту `data-testid` или стабильный бизнес-ключ. См. [RFC идентификаторов UI-узлов и восстановления после обновления](rfc-ui-identifiers.md).
- Автоматическое определение продуктового назначения произвольной разметки. Приложение предоставляет обработчики и контекстные атрибуты.

## Детальный дизайн

### Контракт снимка

```ts
interface UiSnapshot {
  version: 1;
  __capturedAt: string;
  roots: UiRoot[];
}

interface UiRoot {
  id: string; // e.g. tab-invoices or popup-actions
  name?: string;
  tree: UiNode[];
}

interface UiNode {
  domId?: string; // present when the source element has an HTML id
  tag?: string;
  role?: string;
  label?: string;
  description?: string;
  text?: string;
  context?: Record<string, unknown>; // Extensible context for LLM, e.g. { expanded: true, screen: "invoices" }.
  __systemContext?: Record<string, string>; // Backend diagnostics, e.g. { parserSource: "data-screen" }.
  relations?: UiRelation[];
  children?: UiNode[];
}

interface UiControlNode extends UiNode {
  id: string;
  __xpath: string;
  control: {
    type: string; // e.g. "button", "text-input", "select", "calendar"
    __atomic: boolean; // Stop DOM traversal; descendants are represented by tools.
    tools?: ControlTool[];
  };
}

interface UiUnhandledNode extends UiNode {
  id: string;
  __xpath: string;
}

interface UiRelation {
  type: "labelledby" | "controls";
  targetDomIds: string[];
}
```

### Легенда полей

| Поле | Назначение | Передача на backend |
| --- | --- | --- |
| `UiSnapshot.version` | Версия канонического контракта снимка. | Проверка совместимости parser-а, схемы хранения и decoder-ов. |
| `UiSnapshot.__capturedAt` | Время захвата снимка. | Корреляция с событием, измерение устаревания снимка и диагностика задержек. Не передаётся в LLM. |
| `UiSnapshot.roots` | Независимые активные контексты интерфейса. | Валидация полноты снимка и разделения зарегистрированных root. |
| `UiRoot.id` | Стабильный в рамках снимка идентификатор root. | Адресация, корреляция событий и проверка уникальности. |
| `UiRoot.name` | Доступное имя root, если оно определено. | Диагностика доступности и контекст для LLM. |
| `UiRoot.tree` | Корневые узлы семантического дерева. | Хранение полного дерева и структурная валидация. |
| `UiNode.domId` | Исходный HTML `id` сохранённого DOM-элемента. | Разрешение ARIA-связей и диагностика дубликатов HTML id. |
| `UiNode.tag` | Значимый HTML-тег. | Проверка сохранения HTML-семантики; доступен LLM как контекст. |
| `UiNode.role` | ARIA-роль элемента. | Диагностика доступности и классификация интерактивных элементов. |
| `UiNode.label` | Accessible name узла. | Контроль качества доступных имён и контекст для LLM. |
| `UiNode.description` | Accessible description узла. | Диагностика доступности и дополнительный контекст для LLM. |
| `UiNode.text` | Нормализованный пользовательский текст. | Анализ полноты парсинга и контекст для LLM после redaction. |
| `UiNode.context` | Расширяемый прикладной контекст для LLM, например `{ screen: "invoices", field: "customer", expanded: true }`. Он собирается из allow-list `data-*` атрибутов, handler-ов и других источников. | Передаётся в LLM как дополнительный контекст узла; backend валидирует схему и источник значений. |
| `UiNode.__systemContext` | Технический контекст parser-а, например `{ parserSource: "data-screen" }`. | Отладка parser-а, корреляция с продуктовым UI и диагностика источника данных; исключается из LLM. |
| `UiNode.relations` | ARIA-связи с элементами вне DOM-вложенности. | Проверка целостности ссылок и сохранение контекста для LLM. |
| `UiNode.children` | Вложенные узлы. | Проверка вложенности, лимитов глубины и отсутствия children у атомарного контрола. |
| `UiControlNode.id` / `UiUnhandledNode.id` | Непрозрачная цель действия в текущем снимке. | Адресация dispatch, аудит действия и проверка уникальности. |
| `UiControlNode.__xpath` / `UiUnhandledNode.__xpath` | Точный DOM locator интерактивного элемента. | Диагностика handler-ов, расследование отказов dispatch и сопоставление с DOM; исключается из LLM. |
| `UiControlNode.control.type` | Нормализованный тип поддерживаемого контрола, например `button`, `text-input`, `select` или `calendar`. | Выбор handler-а, валидация tools и метрики покрытия контролов. |
| `UiControlNode.control.__atomic` | Признак, что обход DOM остановлен и потомки представлены tools. | Проверка инварианта отсутствия children и диагностика решений handler-а; исключается из LLM. |
| `UiControlNode.control.tools` | Allow-list действий контрола. | Валидация и исполнение LLM action; в LLM передаётся безопасная проекция без технического payload. |
| `UiRelation.type` | Семантика связи: `labelledby` или `controls`. | Проверка допустимого типа связи и её интерпретация. |
| `UiRelation.targetDomIds` | HTML id узлов, на которые указывает связь. | Валидация существования target и разрешение связи между root. |

Поля с префиксом `__` являются backend-only: LLM-projection должна исключать их независимо от product-specific redaction policy. `context` содержит расширяемый прикладной контекст, нужный модели для выбора действия: например, `data-screen="invoices"` сохраняется как `{ screen: "invoices" }`, а `aria-expanded="true"` — как `{ expanded: true }`. Его значения могут поступать из allow-list `data-*` атрибутов, handler-ов или других зарегистрированных источников. `__systemContext` содержит только технические сведения parser-а и источники диагностики. Идентификатор `UiNode.id` выдаётся только интерактивным `control` и `unhandled` узлам и является action target для LLM; у `control` он совпадает с `control.id`. `__xpath` хранит точный DOM locator интерактивного элемента для логов и диагностики. `domId` содержит исходный HTML `id` любого сохранённого узла и является target-идентификатором для ARIA relations. Поэтому элемент с HTML `id` сохраняется, даже если без этой связи он был бы схлопнут как presentation-wrapper. Узел с `control` — поддерживаемый control; узел с `id`, но без `control`, — `unhandled`; узел с `text`, но без `tag`, — текстовый; остальные сохранённые узлы являются структурными и определяются по `tag` и `children`. Значимые HTML-теги (`section`, `article`, `nav`, `fieldset`, `ul`, `li`, `table`, `tr`, `td` и т. п.) сохраняются. Семантические WAI-ARIA контейнеры, например `[role="group"]`, `[role="region"]` и `[role="toolbar"]`, также сохраняются вместе с ролью и доступным именем. Нейтральные `div` и `span` без семантического тега, роли или ARIA-имени сохраняются как контейнер, если после рекурсивного парсинга содержат более одной дочерней ноды. При одной или нуле дочерних нод это presentation-wrapper, и его потомки поднимаются на уровень выше. Соседние текстовые узлы после схлопывания объединяются в один нормализованный текст. Для каждого контейнера, сохранённого этой эвристикой, parser добавляет backend-диагностику `{ code: "heuristic-container", severity: "info", message: "Neutral wrapper retained because it has multiple child nodes" }`.

`label` не является сводкой всего descendant text. Для `control` и `unhandled` parser следует порядку accessible name: `aria-labelledby`, затем `aria-label`, связанный нативный `<label>` для labelable HTML-контрола, text content элемента и `title` только как поздний fallback. `aria-description` не является именем: он записывается в `description`; `aria-describedby` имеет перед ним приоритет при вычислении описания. У структурных контейнеров `label` задаётся только `aria-labelledby`, `aria-label` или собственным семантическим источником: `caption` для `table`, `legend` для `fieldset`, `figcaption` для `figure`, `summary` для `details`. Контейнер без такого имени не получает `label`: его содержание выражается через `children`.

### ARIA-связи вне DOM-вложенности

`aria-labelledby` и `aria-controls` являются связями между узлами, а не указанием на вложенность. Парсер сохраняет их в `relations`; он не перемещает popup под trigger и не дублирует label-узлы в детей контрола.

- Для `aria-labelledby="customer number"` parser сохраняет target-элементы с `domId: "customer"` и `domId: "number"`, а в связи записывает только `{ type: "labelledby", targetDomIds: ["customer", "number"] }`. Их текст разрешается при построении LLM-проекции согласно RFC передачи UI-снимков.
- Для `aria-controls="invoice-menu"` trigger получает связь `{ type: "controls", targetDomIds: ["invoice-menu"] }`. Target с `domId: "invoice-menu"` остаётся в своём registered portal-root; оба root независимы, но LLM может связать trigger и popup через общий DOM id.
- `aria-expanded`, если присутствует, сохраняется в `context` как boolean `expanded` при явном включении в product-specific whitelist либо как handler-specific параметр контрола. Само наличие `aria-controls` не делает элемент исполняемым: для действия по-прежнему требуется handler и разрешённый tool.

Незарегистрированные `button`, `input`, `select` или `textarea` становятся узлом `unhandled`. Такой узел остаётся наблюдаемым, поэтому отсутствие обработчика можно валидировать и инструментировать. Другие неизвестные элементы остаются прозрачными, если у них нет семантических признаков (`role` или ARIA-имени).

Помимо нативных элементов, parser применяет консервативную эвристику, аналогичную подходу browser automation tools: `unhandled` создаётся для незарегистрированного видимого элемента с интерактивной ARIA-ролью (`button`, `link`, `tab`, `menuitem`, `option`, `checkbox`, `radio`, `switch`, `treeitem`), `onclick`, `data-action`, `data-click`, Angular `(click)`, `ng-click`, `contenteditable`, подходящим `tabindex` или CSS `cursor: pointer`. Элементы `disabled` и `aria-disabled="true"` исключаются. Такой узел остаётся только диагностическим: без зарегистрированного `ControlHandler` LLM не получает tools и executor не выполняет клик по эвристике.

### Проекции для LLM и backend

`UiSnapshot` является каноническим внутренним DTO. Его нельзя передавать в LLM целиком: он содержит технические поля, увеличивающие prompt, и может содержать значения, не нужные для выбора действия. Из одного snapshot строятся две независимые проекции.

### LLM: минимальная action-проекция

В LLM передаётся только контекст, необходимый для понимания интерфейса и выбора разрешённого действия:

```ts
interface LlmUiContext {
  snapshotId: string;
  parserVersion: 1;
  event?: Pick<UiEvent, "rootId" | "controlId" | "type">;
  roots: LlmRoot[];
}

interface LlmRoot {
  id: string;
  name?: string;
  tree: LlmNode[];
}

interface LlmNode {
  id?: string; // only for control and unhandled
  domId?: string;
  tag?: string;
  role?: string;
  label?: string;
  description?: string;
  text?: string;
  context?: Record<string, unknown>;
  relations?: LlmRelation[];
  control?: {
    type: string;
    value?: string | boolean | number | null;
    tools: Array<Pick<ControlTool, "id" | "type" | "label">>;
  };
  children?: LlmNode[];
}

interface LlmRelation {
  type: "labelledby" | "controls";
  targetDomIds: string[];
}
```

В LLM-проекцию включаются:

- Только активные root-узлы, относящиеся к текущему пользовательскому событию, и необходимые связанные portal-root узлы.
- Семантика контекста: значимые `tag`, `role`, `label`, `description`, `text`, `context` и вложенность. Роль узла выводится из его полей так же, как в каноническом DTO.
- У контрола только непрозрачный `id`, `type`, допустимый `value` и allow-list `tools`. Идентификаторы неинтерактивных узлов не передаются.
- `relations` передаются вместе с `targetDomIds`; каждое значение сопоставляется с `domId` узла, в том числе в другом active root. Текст `labelledby`-связи вычисляется в LLM-проекции согласно RFC передачи UI-снимков.
- `unhandled` как информационный узел без tools: модель видит часть интерфейса, но не получает право совершить в ней действие.

В LLM-проекцию не включаются:

- Все поля с префиксом `__`: в том числе `__capturedAt`, `__atomic` и `ControlTool.__payload`, а также event/telemetry fields.
- `__systemContext`: это backend-диагностика, а не контекст для выбора действия.

Например, LLM может вернуть только строго валидируемое действие:

```json
{ "rootId": "tab-invoices", "controlId": "control_8f3...", "toolId": "activate", "type": "click" }
```

### Backend: валидация качества парсинга

Backend получает канонический snapshot и отдельный quality envelope. Он не использует ответ LLM как источник истины о структуре UI.

```ts
interface ParserQualityEnvelope {
  snapshotId: string; // Correlates the canonical snapshot, LLM context, and action.
  snapshotHash: string; // Detects corruption or mismatch of the canonical snapshot.
  parserVersion: 1;
  applicationVersion: string;
  capturedAt: string;
  parseDurationMs: number;
  roots: UiRoot[];
  stats: ParserQualityStats;
  diagnostics: ParserDiagnostic[];
  dispatch?: ParserDispatchResult;
}

interface ParserQualityStats {
  rootCount: number;
  nodeCount: number;
  controlCount: number;
  unhandledInteractiveCount: number;
  heuristicContainerCount: number;
  tokenEstimate: number;
}

interface ParserDiagnostic {
  code: string; // e.g. "unhandled-interactive" or "duplicate-control-id"
  severity: "info" | "warning" | "error";
  rootId?: string;
  controlId?: string;
  message: string;
}

interface ParserDispatchResult {
  actionId: string;
  result: "executed" | "rejected";
  rejectionReason?: "root-not-found" | "control-not-found" | "tool-not-allowed" | "handler-not-found";
}
```

`ParserQualityEnvelope` целиком backend-only, поэтому его поля не используют префикс `__`: этот префикс нужен внутри DTO, которые могут попасть в LLM-проекцию. Envelope создаётся на каждый canonical snapshot и используется в следующем порядке:

1. Parser записывает `snapshotId`, `snapshotHash`, версии, время, длительность и полное `roots`.
2. Validator рассчитывает `stats` и добавляет `diagnostics` для нарушенных инвариантов или эвристик.
3. После попытки действия LLM executor добавляет `dispatch` к snapshot, по которому действие было принято.
4. Backend сохраняет envelope и отправляет его в observability, связывая записи по `snapshotId` и `snapshotHash`.

| Поле | Как использовать |
| --- | --- |
| `snapshotId`, `snapshotHash` | Связать snapshot, LLM request, action и результат dispatch; hash использовать для поиска рассинхронизации. |
| `parserVersion`, `applicationVersion` | Сегментировать метрики и находить регрессии после выпуска parser-а или приложения. |
| `capturedAt`, `parseDurationMs` | Контролировать задержку и P95 времени парсинга. |
| `roots` | Анализировать исходное дерево и воспроизводить diagnostic без передачи его в LLM. |
| `stats` | Строить дашборды размера дерева, покрытия control, числа эвристических контейнеров и token estimate. |
| `diagnostics` | Агрегировать причины качества: неизвестный интерактивный элемент, дублирующийся id, ошибка handler-а или `heuristic-container`. |
| `dispatch` | Измерять разрешённые и отклонённые LLM-действия, группируя причины отказа. |

Backend обязан валидировать и сохранять:

- Полное дерево `roots` до LLM-компактизации, включая `UiNode.id`, `__atomic`, `__systemContext` только в рамках политики хранения данных, и список `unhandled`.
- Структурные инварианты: уникальность root/control id в рамках snapshot, отсутствие children у атомарного контрола, наличие tools у action-контрола, отсутствие неизвестного интерактивного HTML без diagnostics, отсутствие циклов и превышения лимитов глубины/узлов.
- Семантические метрики: долю контролов с доступным именем, число схлопнутых presentation-wrapper и эвристических контейнеров, число и типы `unhandled`, неоднозначные matches handler-ов, число пустых структурных узлов и разделение табов/диалогов/порталов по root.
- Эксплуатационные метрики: `parseDurationMs`, token estimate канонической и LLM-проекции, размер JSON, число игнорируемых мутаций, стабильность `controlId` на соседних snapshot в рамках одной страницы, результат dispatch и причину отказа.
- Корреляцию для Langfuse: `snapshotId`, `snapshotHash`, parser/application version, LLM action и результат исполнения. Сырым HTML/DOM сохранять нельзя по умолчанию; для отладки следует хранить разрешённый snapshot или его redacted вариант.

Таким образом, LLM получает минимальный снимок для решения задачи, а backend — достаточные данные, чтобы обнаруживать регрессии обработчиков, потерю вложенных контролов, рост токенов и нарушение временного бюджета без передачи диагностического шума в prompt.

### Контролы и Taiga UI

`ControlHandler` содержит `matches`, `parse` и необязательный `dispatch`. Результат его `parse` определяет `atomic`:

- Атомарный: календарь, расширенный select, сложный ввод диапазона дат. Потомки намеренно исключаются; все действия LLM представлены именованными `tools`.
- Неатомарный: expand/accordion, оболочка таблицы, группа навигации. Компонент явно представлен как контрол, но его содержимое по-прежнему рекурсивно парсится.

Обработчики Taiga следует регистрировать до регистрации root-узлов. Для сопоставления обычно используют host-тег, класс директивы, ARIA-роль или принадлежащий продукту маркер. В `ParserOptions.contextAttributes` нужно указать прикладные атрибуты, например `data-e2e`, `data-mf`, `data-screen` и `formcontrolname`; их значения копируются в `context` ближайшего распарсенного узла. Handler-ы и другие зарегистрированные источники могут добавлять туда типизированные значения, например `expanded: true`; общий parser не интерпретирует эти значения.

Для Taiga UI v3 `tuiInput` и обычный `tuiSelect` применяются к нативному `input`, а native-вариант select — к `select`. Готовые примеры находятся в `taiga-control-handlers.ts`; их нужно зарегистрировать до generic handlers:

```ts
for (const handler of taigaControlHandlers) {
  parser.registerHandler(handler);
}
```

Обычный `input[tuiSelect]` предоставляет только `open-menu` и `clear`: его value является строковым представлением выбранного объекта, поэтому нельзя безопасно выбирать объект присваиванием строки. После `open-menu` dropdown регистрируется отдельным portal-root, а LLM выбирает option кликом. Для `select[tuiSelect]` доступен `set-value`, который устанавливает native value и отправляет `change`.

```ts
parser.registerHandler({
  type: "tui-calendar",
  matches: (element) => element.matches("tui-calendar"),
  parse: () => ({ __atomic: true, type: "calendar", tools: [{ id: "select-date", type: "select" }] }),
  dispatch: (element, event) => calendarAdapter.select(element, String(event.value)),
});
```

### Протокол событий и действий

При захвате пользовательского взаимодействия следует отправлять и логировать этот envelope вместе со снимком и версией парсера:

```ts
interface UiEvent {
  __eventId: string;
  __occurredAt: string;
  __source: "user" | "llm";
  rootId: string;
  controlId: string;
  toolId?: string;
  type: "click" | "input" | "change" | "keydown" | "custom";
  value?: string | boolean | number | null;
  __systemContext?: Record<string, string>;
}
```

Вывод LLM должен быть ограничен объектом `{ rootId, controlId, toolId, type, value }`. Исполнитель находит `rootId`, разрешает непрозрачный идентификатор только внутри этого root, проверяет, что запрошенный tool сейчас доступен, и вызывает обработчик контрола. Отправка браузерного события является запасным вариантом только для поддерживаемого нативного контрола. Отсутствующий root/control/tool означает отклонённое действие: оно логируется и никогда не подбирается предположением.

### Root-узлы, порталы и планирование мутаций

Angular-сервис `UiParserService` явно регистрирует root каждой активной вкладки/страницы и каждого overlay из CDK/Taiga. Он использует один `MutationObserver` и планирует не более одного обновления в microtask на пачку мутаций. Root может предоставлять `ignored(mutation)` для фильтрации известных шумных узлов: контейнеров анимации, таймеров, элементов измерения virtual scroll. Production-интеграция должна отключать observer, когда root-узлов не осталось, и измерять `refresh()` через `performance.mark`/`measure`; согласованный бюджет N ms нужно проверять в CI на репрезентативных DOM-фикстурах.

Порталы следует регистрировать при открытии и отменять регистрацию при закрытии. Они никогда не объединяются с деревом инициатора, поэтому действия в popup можно безопасно адресовать независимо.

### Политика токенов и валидации

- Передавать только активные root-узлы, нужные для текущего действия пользователя, и удалять поля со значением `undefined` при сериализации.
- Сохранять семантические теги и компактные значения; по умолчанию не сериализовать CSS-классы, стили, DOM-пути и скрытый контент.
- Выдавать диагностику: дублирующийся id root-узла, необработанный интерактивный узел, контрол без tools, неоднозначное сопоставление обработчиков, отсутствующее доступное имя, превышение лимита узлов/токенов.
- Добавить fixture-тесты для контролов в ячейках таблицы, вложенных списков, неатомарного expand, атомарного календаря, разделения диалога/портала и фильтрации игнорируемых мутаций. Тесты обработчиков хранить рядом с каждым продуктовым адаптером.
- В Langfuse логировать id снимка, id root-узлов, id контролов, действие LLM, результат dispatch, длительность парсинга, диагностику и компактный хеш снимка. Полный снимок хранить только там, где это допускает политика приватности.

### Внедрение

1. Запустить новый парсер в shadow mode рядом с текущим плоским парсером и сравнивать количество контролов и диагностику `unhandled`.
2. Добавить обработчики для часто используемых контролов Taiga, явно выбирая атомарность.
3. Разрешить действия LLM только для tools из allow-list и собирать метрики отклонений/dispatch.
4. Переключать типы виджетов/root-узлов постепенно, оставляя преобразование в плоский DTO только как временный адаптер совместимости.

## Недостатки

- DOM-first обход чувствителен к изменениям разметки и к качеству ARIA-атрибутов; продуктовым командам потребуется поддерживать group-маркеры и доступные имена.
- Сложные контролы требуют явных обработчиков и adapter-ов для безопасного dispatch. До их реализации интерактивные элементы останутся `unhandled`.
- Полное семантическое дерево крупнее плоского DTO для backend и требует budget-ограничений, redaction policy и наблюдения за метриками.
- Идентификаторы текущего RFC действуют в пределах жизни документа. Их стабильность между navigation/reload определяется отдельной стратегией идентичности.

## Альтернативы

| Вариант | Причина отказа в качестве основного решения |
| --- | --- |
| Плоский `Widget[] / Control[]` | Не сохраняет границы таблиц, списков и неатомарных составных контролов. |
| Полный HTML или DOM serialization | Передаёт presentation-детали, скрытые данные и значительно увеличивает prompt. |
| Accessibility tree браузера как единственный источник | Недостаточно переносим между браузерами и не содержит product-specific tools/dispatch. |
| Hand-authored screen schema | Даёт высокое качество на отдельных экранах, но дорого поддерживается и отстаёт от UI. |

## Нерешенные вопросы

1. Какие атрибуты следует включить в обязательный product-level контракт для обозначения семантических групп и бизнес-контекста?
2. Каким должен быть измеряемый P95 бюджет парсинга и размера canonical snapshot для репрезентативных МФ?
3. Какие Taiga UI контролы и действия входят в первую allow-list волну?
4. Какая политика хранения redacted snapshot и диагностики соответствует требованиям каждого продукта?
5. Какой формат LLM-проекции и механизм передачи дельт выбираются по результатам RFC о кодировании и event sourcing UI-снимков для LLM?
