# RFC: Семантический UI-парсер и протокол действий

## Статус

Предлагаемая эталонная реализация. Код в `src/app/parser-core` намеренно не зависит от фреймворка; Angular отвечает за жизненный цикл, root-узлы, наблюдение и обработчики, специфичные для Taiga UI.

## Проблема

Плоский протокол `Widget[] / Control[]` теряет видимую пользователю иерархию и трактует контейнеры, например таблицу или expand из Taiga, как один жёстко заданный контрол. В результате контролы внутри ячеек исчезают, а раскрываемое содержимое становится неадресуемым текстом. DOM-first дерево должно сохранять семантику и одновременно позволять известным составным виджетам оставаться атомарными.

## Цели

- Сохранять значимую HTML-семантику и вложенность списков/таблиц без сериализации, зависящей от отступов.
- Присваивать каждому узлу, с которым можно взаимодействовать, непрозрачный непоследовательный идентификатор `control_<uuid>`, пригодный для поиска в логах.
- Делать регистрацию обработчиков аддитивной, а решение об атомарности — ответственностью обработчика.
- Захватывать пользовательские события и воспроизводить выбранный LLM tool через тот же обработчик.
- Рассматривать вкладку, диалог, popup, уведомление и страницу как независимо адресуемые root-узлы.
- Оставлять неподдерживаемый интерактивный HTML видимым как `unhandled`, а не молча исключать его.

## Не входит в цели

- Восстановление UUID, существующих только во время работы страницы, после полного обновления браузера. Это опционально: если необходима идентичность между обновлениями, следует использовать принадлежащий продукту `data-testid` или стабильный бизнес-ключ.
- Автоматическое определение продуктового назначения произвольной разметки. Приложение предоставляет обработчики и контекстные атрибуты.

## Контракт снимка

LLM получает JSON, а не формат, зависящий от пробелов и отступов:

```ts
interface UiSnapshot {
  version: 1;
  __capturedAt: string;
  roots: UiRoot[];
}

interface UiRoot {
  id: string; // e.g. tab-invoices or popup-actions
  kind: "page" | "tab" | "dialog" | "popup" | "notification";
  name?: string;
  tree: UiNode[];
}

interface UiNode<Kind extends NodeKind = NodeKind> {
  domId?: string; // present when the source element has an HTML id
  kind: Kind;
  tag?: string;
  role?: string;
  label?: string;
  description?: string;
  text?: string;
  __context?: Record<string, string>;
  relations?: UiRelation[];
  children?: UiNode[];
}

interface UiControlNode extends UiNode<"control"> {
  id: string;
  __xpath: string;
  kind: "control";
  control: { type: string; __atomic: boolean; tools?: ControlTool[] };
}

interface UiUnhandledNode extends UiNode<"unhandled"> {
  id: string;
  __xpath: string;
  kind: "unhandled";
}

interface UiRelation {
  type: "labelledby" | "controls";
  targetDomIds: string[];
  text?: string;
}
```

Поля с префиксом `__` являются backend-only: LLM-projection должна исключать их независимо от product-specific redaction policy. Идентификатор `UiNode.id` выдаётся только интерактивным `control` и `unhandled` узлам и является action target для LLM; у `control` он совпадает с `control.id`. `__xpath` хранит точный DOM locator интерактивного элемента для логов и диагностики. `domId` содержит исходный HTML `id` любого сохранённого узла и является target-идентификатором для ARIA relations. Поэтому элемент с HTML `id` сохраняется, даже если без этой связи он был бы схлопнут как presentation-wrapper. У `semantic`, `group` и `content` action-идентификатора нет: они не являются целями LLM-действий. `semantic` сохраняет значимые теги (`section`, `article`, `ul`, `li`, `table`, `tr`, `td` и т. п.). `group` сохраняет агрегирующий `div`: с явным маркером `data-parser-group`, `data-ui-group` или `data-mf-group`, либо с двумя и более прямыми интерактивными/семантическими потомками. Например, контейнер пары `Save` / `Cancel` и строка фильтров остаются группой; одиночная layout-обёртка вокруг текста и кнопки схлопывается. Это даёт LLM границу намеренно объединённого UI без сохранения каждой framework-обёртки. `span` и `div` без группового сигнала удаляются: их потомки поднимаются на уровень выше. Соседние `content` после такого схлопывания объединяются в один нормализованный текст.

`label` не является сводкой всего descendant text. Для `control` и `unhandled` parser следует порядку accessible name: `aria-labelledby`, затем `aria-label`, связанный нативный `<label>` для labelable HTML-контрола, text content элемента и `title` только как поздний fallback. `aria-description` не является именем: он записывается в `description`; `aria-describedby` имеет перед ним приоритет при вычислении описания. У `semantic`/`group` `label` задаётся только `aria-labelledby`, `aria-label` или собственным семантическим источником: `caption` для `table`, `legend` для `fieldset`, `figcaption` для `figure`, `summary` для `details`. Контейнер без такого имени не получает `label`: его содержание выражается через `children`.

Автоматическая эвристика не способна надёжно отличить layout от продуктовой группы. Для важной границы команда МФ обязана поставить один из group-маркеров и при необходимости ARIA-имя. Это правило валидируется backend-диагностикой: неразмеченная группа из нескольких интерактивных потомков помечается как эвристическая, а разметка с `data-*-group` — как явная.

### ARIA-связи вне DOM-вложенности

`aria-labelledby` и `aria-controls` являются связями между узлами, а не указанием на вложенность. Парсер сохраняет их в `relations`; он не перемещает popup под trigger и не дублирует label-узлы в детей контрола.

- Для `aria-labelledby="customer number"` parser сохраняет target-элементы с `domId: "customer"` и `domId: "number"`, нормализует их text content в порядке атрибута и записывает объединённый текст `Customer #184` в `label` и `relations[].text`. `targetDomIds: ["customer", "number"]` прямо сопоставляется с этими узлами в LLM-проекции.
- Для `aria-controls="invoice-menu"` trigger получает связь `{ type: "controls", targetDomIds: ["invoice-menu"] }`. Target с `domId: "invoice-menu"` остаётся в своём registered portal-root; оба root независимы, но LLM может связать trigger и popup через общий DOM id.
- `aria-expanded`, если присутствует, остаётся в `context` только при явном включении в product-specific whitelist либо как handler-specific параметр контрола. Само наличие `aria-controls` не делает элемент исполняемым: для действия по-прежнему требуется handler и разрешённый tool.

Незарегистрированные `button`, `input`, `select` или `textarea` становятся узлом `unhandled`. Такой узел остаётся наблюдаемым, поэтому отсутствие обработчика можно валидировать и инструментировать. Другие неизвестные элементы остаются прозрачными, если у них нет семантических признаков (`role` или ARIA-имени).

Помимо нативных элементов, parser применяет консервативную эвристику, аналогичную подходу browser automation tools: `unhandled` создаётся для незарегистрированного видимого элемента с интерактивной ARIA-ролью (`button`, `link`, `tab`, `menuitem`, `option`, `checkbox`, `radio`, `switch`, `treeitem`), `onclick`, `data-action`, `data-click`, Angular `(click)`, `ng-click`, `contenteditable`, подходящим `tabindex` или CSS `cursor: pointer`. Элементы `disabled` и `aria-disabled="true"` исключаются. Такой узел остаётся только диагностическим: без зарегистрированного `ControlHandler` LLM не получает tools и executor не выполняет клик по эвристике.

## Проекции для LLM и backend

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
  kind: UiRoot["kind"];
  name?: string;
  tree: LlmNode[];
}

interface LlmNode {
  kind: "semantic" | "group" | "content" | "control" | "unhandled";
  id?: string; // only for control and unhandled
  domId?: string;
  tag?: string;
  role?: string;
  label?: string;
  description?: string;
  text?: string;
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
  text?: string;
}
```

В LLM-проекцию включаются:

- Только активные root-узлы, относящиеся к текущему пользовательскому событию, и необходимые связанные portal-root узлы.
- Семантика контекста: `kind`, значимые `tag`, `role`, `label`, `description`, `text` и вложенность.
- У контрола только непрозрачный `id`, `type`, допустимый `value` и allow-list `tools`. Идентификаторы неинтерактивных узлов не передаются.
- `relations` передаются вместе с `targetDomIds`; каждое значение сопоставляется с `domId` узла, в том числе в другом active root. Для `labelledby` также передаётся разрешённый текст связи.
- `unhandled` как информационный узел без tools: модель видит часть интерфейса, но не получает право совершить в ней действие.

В LLM-проекцию не включаются:

- Все поля с префиксом `__`: в том числе `__capturedAt`, `__context`, `__atomic` и `ControlTool.__payload`, а также event/telemetry fields.
- `context` и `value`, содержащие персональные данные, токены, пароли, номера документов или иные чувствительные поля. Перед проекцией применяется product-specific redaction policy; для password/file input значение всегда исключается.

Например, LLM может вернуть только строго валидируемое действие:

```json
{ "rootId": "tab-invoices", "controlId": "control_8f3...", "toolId": "activate", "type": "click" }
```

### Backend: валидация качества парсинга

Backend получает канонический snapshot и отдельный quality envelope. Он не использует ответ LLM как источник истины о структуре UI.

```ts
interface ParserQualityEnvelope {
  snapshotId: string;
  __snapshotHash: string;
  parserVersion: 1;
  __applicationVersion: string;
  __capturedAt: string;
  __parseDurationMs: number;
  __roots: UiRoot[];
  __stats: {
    rootCount: number;
    nodeCount: number;
    controlCount: number;
    unhandledInteractiveCount: number;
    tokenEstimate: number;
  };
  __diagnostics: ParserDiagnostic[];
  __trigger?: Pick<UiEvent, "__eventId" | "rootId" | "controlId" | "type">;
  __dispatch?: {
    actionId: string;
    result: "executed" | "rejected";
    rejectionReason?: "root-not-found" | "control-not-found" | "tool-not-allowed" | "handler-not-found";
  };
}
```

Backend обязан валидировать и сохранять:

- Полное дерево `roots` до LLM-компактизации, включая `UiNode.id`, `__atomic`, `__context` только в рамках политики хранения данных, и список `unhandled`.
- Структурные инварианты: уникальность root/control id в рамках snapshot, отсутствие children у атомарного контрола, наличие tools у action-контрола, отсутствие неизвестного интерактивного HTML без diagnostics, отсутствие циклов и превышения лимитов глубины/узлов.
- Семантические метрики: долю контролов с доступным именем, число схлопнутых presentation-wrapper, число и типы `unhandled`, неоднозначные matches handler-ов, число пустых semantic-узлов и разделение табов/диалогов/порталов по root.
- Эксплуатационные метрики: `parseDurationMs`, token estimate канонической и LLM-проекции, размер JSON, число игнорируемых мутаций, стабильность `controlId` на соседних snapshot в рамках одной страницы, результат dispatch и причину отказа.
- Корреляцию для Langfuse: `snapshotId`, `snapshotHash`, parser/application version, пользовательское событие, LLM action и результат исполнения. Сырым HTML/DOM сохранять нельзя по умолчанию; для отладки следует хранить разрешённый snapshot или его redacted вариант.

Таким образом, LLM получает минимальный снимок для решения задачи, а backend — достаточные данные, чтобы обнаруживать регрессии обработчиков, потерю вложенных контролов, рост токенов и нарушение временного бюджета без передачи диагностического шума в prompt.

### Бюджет контекста относительно текущего плоского DTO

Точное увеличение нельзя утверждать до shadow-замера на реальных МФ: текущий `textRepresentation` уже дублирует часть текста, а число семантических групп и глубина дерева у экранов различаются. Для планирования принимаются следующие целевые диапазоны для **одного и того же активного UI-контекста**:

| Проекция                                             | Ожидаемое изменение к текущему `Widget[] / Control[]` |                                             P95 лимит при rollout |
| ---------------------------------------------------- | ----------------------------------------------------: | ----------------------------------------------------------------: |
| Канонический `UiSnapshot` для backend                |                                              +80–200% | Не является LLM prompt; ограничивается размером telemetry payload |
| LLM JSON-проекция с семантическим деревом            |                                               +25–45% |                                                     не более +50% |
| Компактный XML/DSL-представитель той же LLM-проекции |                                               +10–25% |                                                     не более +30% |

Это прогноз, а не гарантия. Его нужно подтвердить до включения actions: для каждого shadow snapshot backend сериализует текущий плоский DTO, LLM JSON-проекцию и при наличии XML/DSL-проекцию одним и тем же tokenizer целевой модели. Метрика рассчитывается так:

$$
\Delta_{\mathrm{pct}} = \frac{tokens(\text{новая LLM-проекция}) - tokens(\text{текущий плоский DTO})}{tokens(\text{текущий плоский DTO})} \times 100
$$

В отчёт по каждому МФ входят median, P95 и максимум $\Delta_{\mathrm{pct}}$, а также число `group`, `semantic`, `control` и `unhandled` узлов. При превышении P95 лимита сначала исключаются неактивные root, длинные повторяющиеся строки и технический context; семантические `group` нельзя удалять только ради экономии токенов. Если после этого лимит не достигнут, для LLM выбирается XML/DSL-проекция, тогда как backend продолжает хранить канонический JSON.

## Контролы и Taiga UI

`ControlHandler` содержит `matches`, `parse` и необязательный `dispatch`. Результат его `parse` определяет `atomic`:

- Атомарный: календарь, расширенный select, сложный ввод диапазона дат. Потомки намеренно исключаются; все действия LLM представлены именованными `tools`.
- Неатомарный: expand/accordion, оболочка таблицы, группа навигации. Компонент явно представлен как контрол, но его содержимое по-прежнему рекурсивно парсится.

Обработчики Taiga следует регистрировать до регистрации root-узлов. Для сопоставления обычно используют host-тег, класс директивы, ARIA-роль или принадлежащий продукту маркер. В `ParserOptions.contextAttributes` нужно указать прикладные атрибуты, например `data-e2e`, `data-mf`, `data-screen` и `formcontrolname`; их значения копируются в ближайший распарсенный узел как контекст для отладки и LLM, но не интерпретируются общим парсером.

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

## Протокол событий и действий

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
  __context?: Record<string, string>;
}
```

Вывод LLM должен быть ограничен объектом `{ rootId, controlId, toolId, type, value }`. Исполнитель находит `rootId`, разрешает непрозрачный идентификатор только внутри этого root, проверяет, что запрошенный tool сейчас доступен, и вызывает обработчик контрола. Отправка браузерного события является запасным вариантом только для поддерживаемого нативного контрола. Отсутствующий root/control/tool означает отклонённое действие: оно логируется и никогда не подбирается предположением.

## Root-узлы, порталы и планирование мутаций

Angular-сервис `UiParserService` явно регистрирует root каждой активной вкладки/страницы и каждого overlay из CDK/Taiga. Он использует один `MutationObserver` и планирует не более одного обновления в microtask на пачку мутаций. Root может предоставлять `ignored(mutation)` для фильтрации известных шумных узлов: контейнеров анимации, таймеров, элементов измерения virtual scroll. Production-интеграция должна отключать observer, когда root-узлов не осталось, и измерять `refresh()` через `performance.mark`/`measure`; согласованный бюджет N ms нужно проверять в CI на репрезентативных DOM-фикстурах.

Порталы следует регистрировать при открытии и отменять регистрацию при закрытии. Они никогда не объединяются с деревом инициатора, поэтому действия в popup можно безопасно адресовать независимо.

## Политика токенов и валидации

- Передавать только активные root-узлы, нужные для текущего действия пользователя, и удалять поля со значением `undefined` при сериализации.
- Сохранять семантические теги и компактные значения; по умолчанию не сериализовать CSS-классы, стили, DOM-пути и скрытый контент.
- Выдавать диагностику: дублирующийся id root-узла, необработанный интерактивный узел, контрол без tools, неоднозначное сопоставление обработчиков, отсутствующее доступное имя, превышение лимита узлов/токенов.
- Добавить fixture-тесты для контролов в ячейках таблицы, вложенных списков, неатомарного expand, атомарного календаря, разделения диалога/портала и фильтрации игнорируемых мутаций. Тесты обработчиков хранить рядом с каждым продуктовым адаптером.
- В Langfuse логировать id снимка, id root-узлов, id контролов, действие LLM, результат dispatch, длительность парсинга, диагностику и компактный хеш снимка. Полный снимок хранить только там, где это допускает политика приватности.

## Внедрение

1. Запустить новый парсер в shadow mode рядом с текущим плоским парсером и сравнивать количество контролов и диагностику `unhandled`.
2. Добавить обработчики для часто используемых контролов Taiga, явно выбирая атомарность.
3. Разрешить действия LLM только для tools из allow-list и собирать метрики отклонений/dispatch.
4. Переключать типы виджетов/root-узлов постепенно, оставляя преобразование в плоский DTO только как временный адаптер совместимости.
