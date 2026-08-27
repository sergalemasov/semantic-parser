# RFC: Передача UI-снимков для LLM: кодирование и event sourcing

## Контекст, проблема и объем

Канонический `UiSnapshot` нужен parser-у, backend-диагностике и dispatch, но JSON с повторяющимися ключами, техническими полями и экранированными строками расходует контекст модели. Нельзя экономить токены ценой потери вложенности, доступных имён, разрешённых tools или безопасной границы `rootId`/`controlId`.

RFC выбирает процесс сравнения JSON, XML и компактного DSL для LLM-проекции одного и того же снимка. Он определяет token budget, escaping, валидацию, передачу полного снимка и инкрементальных изменений через event sourcing.

## Цель

- Сократить число input tokens относительно канонического JSON без потери action contract.
- Сохранить однозначность строк, структуры и допустимых действий при сериализации.
- Использовать формат, не зависящий от пробелов и отступов.
- Выбирать формат измерением на реальных snapshot, а не предположением о «компактности».
- Оставить один канонический DTO и независимый строгий decoder для каждого формата.
- Передавать изменения UI вместо повторной отправки неизменившегося снимка при доказанной синхронизации.
- Привязывать действие LLM к конкретной подтверждённой версии снимка.
- Детерминированно восстанавливаться после потери сообщения, reload, смены root или версии parser-а.

## Детальный дизайн

### Общий проекционный контракт

Перед кодированием строится `LlmUiContext` из RFC парсера: только active roots, семантическое дерево, видимые text/label/description, `context`, control `id`, type, value, tools и разрешённые relations. Поля `__*`, DOM locator, CSS-классы и стили удаляются до любого кодирования. Поле `context` сохраняется: это расширяемый прикладной контекст узла для LLM.

Нормализация выполняется один раз: Unicode NFC, collapse whitespace вне preformatted content, удаление `undefined`, стабильная сортировка object keys и массивов tools по id. Строки не сокращаются эвристически.

Текст ARIA-связи не хранится в `UiRelation`. При построении LLM-проекции resolver находит каждый `targetDomIds` среди активных узлов по `domId`. Для `labelledby` он нормализует `text` target-узлов в порядке идентификаторов и добавляет результат в `label` текущего узла: например, `aria-labelledby="customer number"` с target-текстами `Customer` и `#184` даёт `label: "Customer #184"`. Для `controls` resolver сохраняет только `targetDomIds`: эта связь указывает на управляемый узел, а не является его именем. Не найденный target оставляет relation без изменений и записывается в backend-диагностику.

### Форматы-кандидаты

| Формат | Пример контрола | Сильные стороны | Риски |
| --- | --- | --- | --- |
| JSON | `{"id":"control_a","type":"button","label":"Save","tools":["activate"]}` | Нативные schema/decoder, точные типы и широкая поддержка tools. | Повторяет ключи и знаки пунктуации. |
| XML | `<control id="control_a" type="button" label="Save" tools="activate"/>` | Хорошо выражает дерево, меньше повторяющихся ключей. | Обязательное экранирование и неоднозначность списков без схемы. |
| DSL | `c(control_a,button,"Save",[activate])` | Может дать минимум токенов для повторяющейся структуры. | Нужны grammar, parser, escaping и обучение модели; выше цена ошибок. |

JSON остаётся baseline и fallback. XML допускается только с фиксированной схемой тегов/атрибутов. DSL допускается только после того, как decoder подтверждает round-trip с проекцией и все поля action contract представлены явно.

### Сводная таблица: полный снимок без event sourcing

| Вариант | Структура и escaping | Ожидаемый объём | Сложность реализации | Валидация | Когда выбирать |
| --- | --- | --- | --- | --- | --- |
| JSON | Вложенные объекты и массивы; JSON escaping строк. | Baseline; больше токенов из-за ключей. | Низкая. | JSON Schema и typed decoder. | Fallback, первая production-версия или разница с компактным форматом менее 15%. |
| XML | Вложенные теги и атрибуты; XML escaping текста и атрибутов. | Обычно меньше JSON для глубокого дерева, но зависит от tokenizer-а. | Средняя. | Fixed XML schema и XML decoder. | Когда benchmark подтверждает выигрыш токенов при сохранении качества actions. |
| DSL | Операторы `e`, `g`, `t`, `c`, `u`; JSON-совместимое escaping строк. | Потенциально минимальный объём. | Высокая. | Формальная grammar, strict parser и round-trip check. | Когда XML не укладывается в budget, а DSL даёт подтверждённый выигрыш без роста invalid action rate. |

### Схема compact DSL

Предлагаемый кандидат использует фиксированные node operators: `e` HTML-элемент, `g` группирующий `div`/`span`, `t` text, `c` control, `u` unhandled. Дочерние узлы следуют последним аргументом. Роль узла определяется operator-ом и его полями, а не отдельным полем `kind`.

```text
e(section,"Invoices",[
  c(control_save,button,"Save",[activate]),
  t("Draft invoice")
])
```

String literal имеет JSON-совместимое escaping: двойная кавычка, обратный слеш и control characters экранируются как в JSON; untrusted text никогда не интерпретируется как operator. Идентификаторы проходят allow-list `[A-Za-z0-9_-]+`; иначе сериализуются как string. `null`, boolean и number используют JSON literal. Grammar и decoder должны отвергать unknown operators, duplicate attributes, невалидные escape sequence и неполное дерево.

### Бюджет контекста относительно текущего плоского DTO

Точное изменение числа токенов нельзя утверждать до shadow-замера на реальных МФ: текущий `textRepresentation` уже дублирует часть текста, а число групп и глубина дерева у экранов различаются. Для планирования принимаются следующие целевые диапазоны для **одного и того же активного UI-контекста**:

| Представление | Ожидаемое изменение к текущему `Widget[] / Control[]` | P95 лимит при rollout |
| --- | ---: | ---: |
| Канонический `UiSnapshot` для backend | +80–200% | Не является LLM prompt; ограничивается размером telemetry payload |
| JSON-представление LLM-проекции | +25–45% | не более +50% |
| Компактное XML/DSL-представление той же LLM-проекции | +10–25% | не более +30% |

Это прогноз, а не гарантия. Его нужно подтвердить до включения actions: для каждого shadow snapshot backend сериализует текущий плоский DTO, JSON-, XML- и DSL-представления одной LLM-проекции одним и тем же tokenizer целевой модели. Метрика рассчитывается так:

$$
\Delta_{\mathrm{pct}} = \frac{tokens(\text{новое представление}) - tokens(\text{текущий плоский DTO})}{tokens(\text{текущий плоский DTO})} \times 100
$$

В отчёт по каждому МФ входят median, P95 и максимум $\Delta_{\mathrm{pct}}$, а также число группирующих контейнеров, HTML-элементов, control и unhandled узлов. При превышении P95 лимита сначала исключаются неактивные root, длинные повторяющиеся строки и технический `__systemContext`; группирующие контейнеры нельзя удалять только ради экономии токенов. Если после этого лимит не достигнут, выбирается XML/DSL-представление, тогда как backend продолжает хранить канонический DTO.

### Измерение токенов

Для каждого snapshot pipeline кодирует идентичную LLM-проекцию всеми форматами и токенизирует tokenizer-ом конкретной целевой модели. Сравниваются input tokens, bytes, encode/decode latency и round-trip equality.

| Метрика | JSON baseline | XML | DSL | Критерий выбора |
| --- | ---: | ---: | ---: | --- |
| Median/P95 input tokens | 100% | Измеряется | Измеряется | P95 не выше установленного бюджета. |
| Token delta | 0% | Измеряется | Измеряется | Не менее 15% выигрыша против JSON для нового формата. |
| Round-trip mismatch | 0 | Измеряется | Измеряется | 0 для action-полей. |
| Invalid model action rate | Baseline | Измеряется | Измеряется | Не хуже JSON более чем на согласованный порог. |
| Decoder latency | Baseline | Измеряется | Измеряется | Вписывается в request budget. |

Победитель выбирается отдельно по модели и продукту. При равенстве в пределах 5% предпочтителен JSON из-за меньшей эксплуатационной сложности. В prompt всегда указывается выбранный формат и строгий JSON schema для ответа action; формат контекста не изменяет формат ответа модели.

### Инкрементальная передача и event sourcing

Backend является источником истины для истории. Клиент создаёт полный канонический snapshot, а backend назначает ему `snapshotId`, `revision` и детерминированный `snapshotHash`. Первое сообщение в LLM-сессию имеет тип `snapshot.full`; последующие изменения могут передаваться как `snapshot.patch` относительно последнего подтверждённого revision. Журнал событий хранит нормализованный, независимый от кодирования patch; для LLM он сериализуется в выбранном формате.

```ts
interface SnapshotEnvelope {
  sessionId: string;
  snapshotId: string;
  revision: number;
  baseRevision?: number;
  parserVersion: number;
  encoding: "json" | "xml" | "dsl";
  encodingVersion: number;
  snapshotHash: string;
  type: "snapshot.full" | "snapshot.patch" | "snapshot.reset";
  payload: LlmUiContext | UiPatch[];
}

interface UiPatch {
  op: "add" | "remove" | "replace" | "move";
  target: { rootId: string; nodeKey: string };
  parent?: { rootId: string; nodeKey?: string };
  value?: LlmNode;
}
```

`nodeKey` не равен runtime `actionId`. Для control/unhandled используется `semanticId` из RFC идентификаторов; для остальных узлов - детерминированный structural key из root, тега/роли и sibling discriminator. Низкоуверенные ключи не участвуют в `move`: вместо него эмитируется `remove`/`add`. Runtime `actionId` находится внутри `value` и обновляется при каждом новом или изменённом control-узле.

### Event sourcing для форматов LLM

| Формат | Полный снимок | Patch | Правила |
| --- | --- | --- | --- |
| JSON | `LlmUiContext` как JSON-объект. | Массив `UiPatch` в `SnapshotEnvelope`. | Строгая JSON Schema; `value` содержит целый `LlmNode`. |
| XML | Дерево fixed-schema XML. | `<patch>` с `<add>`, `<remove>`, `<replace>`, `<move>`; `value` содержит дочерний XML-узел. | `rootId`, `nodeKey`, `revision` - XML-атрибуты с обязательным escaping. |
| DSL | Полный DSL-контекст с `e`, `g`, `t`, `c`, `u`. | Отдельные operators: `+(target,value)`, `-(target)`, `~(target,value)`, `>(target,parent)`. | Target и value используют ту же grammar и escaping, что и full snapshot. |

### Сводная таблица: event sourcing

| Вариант | Представление full/patch | Достоинства | Риски и сложность | Когда выбирать |
| --- | --- | --- | --- | --- |
| JSON + event sourcing | JSON `LlmUiContext` и массив `UiPatch`. | Простая строгая схема, удобная отладка, единый DTO для журнала и транспорта. | Patch повторяет ключи; размер часто проигрывает XML/DSL при большом числе операций. | Базовый production-вариант event sourcing. |
| XML + event sourcing | XML-дерево и `<patch>` с операциями. | Компактнее передаёт дерево и изменённые поддеревья. | Нужны XML schema, escaping атрибутов и надёжная обработка вложенного `value`. | Когда XML уже выбран для full snapshot и benchmark подтверждает экономию patch. |
| DSL + event sourcing | DSL full snapshot и операторы `+`, `-`, `~`, `>`. | Минимальная запись повторяющихся операций и коротких target. | Наивысший риск ошибок grammar/escaping; сложнее ручная диагностика. | Только после доказанного выигрыша токенов и zero mismatch в apply-and-hash проверках. |
| Full snapshot без patch | Выбранный JSON/XML/DSL при каждом обновлении. | Нет session state и риска diff/apply рассинхронизации. | Повторно передаёт неизменившийся UI. | Обязательный fallback при reset, малых снимках или patch без выигрыша минимум 20%. |

Независимо от формата семантика patch одинакова. `remove` упорядочиваются снизу вверх, затем `move`, затем `add`/`replace` сверху вниз. `replace` всегда содержит целый узел, а не изменение отдельного поля: это исключает различия merge-правил JSON, XML и DSL. Decoder каждого формата преобразует сообщение в `UiPatch[]`, применяет его к нормализованной LLM-проекции и проверяет итоговый `snapshotHash`.

Примеры patch одного изменения:

```json
{
  "type": "snapshot.patch",
  "baseRevision": 41,
  "revision": 42,
  "payload": [{ "op": "replace", "target": { "rootId": "tab-invoices", "nodeKey": "invoice-filter" }, "value": { "id": "control_8f3", "control": { "type": "select", "tools": [{ "id": "open-menu", "type": "click" }] }, "context": { "expanded": true } } }]
}
```

```xml
<patch baseRevision="41" revision="42"><replace rootId="tab-invoices" nodeKey="invoice-filter"><control id="control_8f3" type="select" expanded="true"/></replace></patch>
```

```text
~((tab-invoices,invoice-filter),c(control_8f3,select,{expanded:true},[open-menu]))
```

### Правила отправки, подтверждения и действий

Patch допустим, только если LLM-session подтвердил `baseRevision` и matching `snapshotHash`, active root set, parserVersion, encoding и encodingVersion совместимы, размер patch меньше полного сообщения минимум на 20% в токенах, а число операций не превышает лимит. До отправки и на backend выполняется apply-and-hash проверка.

При нарушении хотя бы одного условия отправляется `snapshot.reset` с полным контекстом. Reload документа, смена пользователя или permission, открытие непредвиденного modal/portal root и изменение алгоритма идентичности также принудительно вызывают reset.

LLM-orchestrator хранит `{ sessionId, revision, snapshotHash }` и подтверждает revision только после успешной schema validation и применения patch. Любое действие модели обязано содержать версию снимка:

```json
{ "snapshotId": "snap_...", "revision": 42, "rootId": "tab-invoices", "controlId": "control_...", "toolId": "activate", "type": "click" }
```

Executor сверяет `snapshotId`, `revision`, hash текущего состояния и наличие tool в актуальном контроле. Несовпадение отклоняет действие с `stale-snapshot`; исполнитель не подбирает другой control, а orchestrator запрашивает `snapshot.reset` и повторяет reasoning на полном актуальном контексте.

### Хранение и наблюдаемость

Event log является append-only: full snapshot/checkpoint, patch, acknowledgement, action и dispatch result. Каждый N revision и после каждого reset сохраняется полный checkpoint. Обязательные метрики: full/patch token count по формату, patch ratio, reset reason, apply/hash mismatch, ack latency, stale-action rate и action success rate.

### Валидация и rollout

1. Собрать corpus snapshot по типам экранов, root и локалям.
2. Реализовать pure encoder/decoder и golden fixtures для JSON, XML, DSL.
3. Проверять structural equality после decode и сохранение каждого `{rootId, controlId, toolId}`.
4. Запустить shadow telemetry всех форматов без изменения production prompt.
5. Включать победивший формат feature flag-ом с JSON fallback при encode/decode/validation error.
6. В shadow mode строить event log и diff, но передавать модели только full snapshot.
7. Проверять apply-and-hash для patch двумя независимыми реализациями decoder-а.
8. Включить patch delivery feature flag-ом; `snapshot.reset` остаётся обязательным fallback.

## Недостатки

- Выигрыш токенов зависит от tokenizer-а и может исчезнуть после смены модели.
- XML и DSL требуют дополнительного parser-а, тестов и версионирования grammar.
- Компактизация делает prompt менее удобным для ручной отладки.
- Агрессивное сокращение текста может лишить модель контекста и ухудшить выбор действия.
- Состояние LLM-сессии, acknowledgements и checkpoints усложняют orchestration.
- Ошибка в diff/apply может скрыто рассинхронизировать UI-контекст; для небольших или полностью меняющихся экранов patch не экономит токены.

## Альтернативы

| Вариант | Причина отказа в качестве единственного решения |
| --- | --- |
| Передавать канонический JSON | Смешивает backend-поля с LLM-контекстом и излишне расходует токены. |
| Только minified JSON | Убирает пробелы, но не повторяющиеся ключи и не задаёт правила проекции. |
| HTML | Не даёт action allow-list и несёт framework/presentation шум. |
| Сжатие gzip/base64 | Модель не может надёжно декодировать бинарный транспорт. |
| Проприетарный DSL без schema | Краток, но не проверяем и уязвим к ambiguity/injection через текст. |
| Всегда передавать full snapshot | Самый простой и остаётся fallback, но повторяет неизменившийся UI. |
| Передавать только событие без UI | Модель не может проверить актуальный контекст и доступные действия. |
| JSON Patch по index-based path | Индексы ломаются при reorder и плохо выражают семантическое перемещение. |
| Хранить состояние только в prompt history | Нельзя подтвердить revision или восстановиться после truncation. |
| Позволить executor подбирать актуальный control | Возникает риск действия над похожим, но другим элементом. |

## Нерешенные вопросы

1. Какие целевые модели и tokenizer версии входят в обязательный benchmark?
2. Каким должен быть абсолютный P95 token budget для одного действия?
3. Допускается ли XML как production-формат без typed schema в toolchain?
4. Какие поля value необходимы для каждого control type?
5. Должен ли выбор encoding быть единым для всех МФ или конфигурируемым на продукт?
6. Кто подтверждает revision: LLM provider, orchestrator или собственный tool endpoint?
7. Какой checkpoint interval оптимален для latency, storage и восстановления?
8. Нужна ли поддержка `move` в первой версии или достаточно `remove`/`add`/`replace`?
9. Какой лимит операций и минимальная token-экономия оправдывают patch?
10. Должна ли event history переживать browser reload и переходить в новую LLM-сессию?