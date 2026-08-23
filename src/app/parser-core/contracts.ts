/** Дискриминатор, определяющий семантику, интерактивность и форму узла дерева. */
export type NodeKind =
  /** Значимый HTML-элемент или ARIA-контейнер, сохраняющий семантическую структуру. */
  | 'semantic'
  /** Явно или эвристически выделенный контейнер, объединяющий несколько UI-потомков. */
  | 'group'
  /** Нормализованный видимый текст без самостоятельной семантической или action-роли. */
  | 'content'
  /** Интерактивный элемент с зарегистрированным handler-ом и allow-list действий. */
  | 'control'
  /** Интерактивный элемент без handler-а, сохранённый для диагностики без действий LLM. */
  | 'unhandled';

/** Полный канонический снимок распарсенного пользовательского интерфейса. */
export interface UiSnapshot {
  /** Версия формата снимка для совместимости parser-а и потребителей. */
  version: 1;
  /** Время создания снимка; служебное поле, не передаваемое LLM. */
  __capturedAt: string;
  /** Независимо адресуемые части интерфейса, например вкладки и popup. */
  roots: UiRoot[];
}

/** Самостоятельная область UI, которую parser наблюдает и адресует отдельно. */
export interface UiRoot {
  /** Стабильный в рамках приложения идентификатор области. */
  id: string;
  /** Тип области, определяющий её место в UI и жизненный цикл. */
  kind: 'page' | 'tab' | 'dialog' | 'popup' | 'notification';
  /** Человекочитаемое имя области, если оно известно приложению. */
  name?: string;
  /** Корневые узлы семантического дерева данной области. */
  tree: UiTreeNode[];
}

/** Общая часть любого узла семантического дерева. */
export interface UiNode<Kind extends NodeKind = NodeKind> {
  /** Исходный HTML id, по которому разрешаются ARIA-связи между узлами. */
  domId?: string;
  /** Дискриминатор варианта узла. */
  kind: Kind;
  /** Исходный HTML-тег, когда узел был создан из элемента. */
  tag?: string;
  /** Явно заданная ARIA-роль элемента. */
  role?: string;
  /** Доступное имя элемента или контейнера. */
  label?: string;
  /** Доступное описание элемента, отдельное от его имени. */
  description?: string;
  /** Нормализованный видимый текст content-узла. */
  text?: string;
  /** Прикладные диагностические атрибуты; не передаются LLM. */
  __context?: Record<string, string>;
  /** ARIA-связи с другими элементами, в том числе вне текущей ветви дерева. */
  relations?: UiRelation[];
  /** Распарсенные дочерние узлы, если элемент не является атомарным. */
  children?: UiTreeNode[];
}

/** Интерактивный узел с зарегистрированным handler-ом и разрешёнными действиями. */
export interface UiControlNode extends UiNode<'control'> {
  /** Непрозрачный action identifier, который LLM возвращает как controlId. */
  id: string;
  /** Точный XPath элемента для backend-логов и диагностики; не передаётся LLM. */
  __xpath: string;
  /** Дискриминатор зарегистрированного интерактивного узла. */
  kind: 'control';
  /** Возможности и текущее состояние зарегистрированного контрола. */
  control: ControlDescriptor;
}

/** Интерактивный элемент без зарегистрированного handler-а. */
export interface UiUnhandledNode extends UiNode<'unhandled'> {
  /** Непрозрачный identifier для диагностики и корреляции событий. */
  id: string;
  /** Точный XPath элемента для backend-логов и диагностики; не передаётся LLM. */
  __xpath: string;
  /** Дискриминатор неподдержанного интерактивного узла. */
  kind: 'unhandled';
}

/** Допустимый узел дерева: структурный, зарегистрированный control или unhandled. */
export type UiTreeNode = UiNode<Exclude<NodeKind, 'control' | 'unhandled'>> | UiControlNode | UiUnhandledNode;

/** Описание возможностей и состояния зарегистрированного контрола. */
export interface ControlDescriptor {
  /** Тип контрола, выбранный его handler-ом, например button или calendar. */
  type: string;
  /** Признак, что parser не должен обходить DOM-потомков контрола; backend-only. */
  __atomic: boolean;
  /** Текущее значение, допустимое для передачи LLM после product-specific redaction. */
  value?: string | boolean | number | null;
  /** Allow-list действий, которые executor может выполнить для контрола. */
  tools?: ControlTool[];
}

/** Одно разрешённое действие зарегистрированного контрола. */
export interface ControlTool {
  /** Идентификатор действия, уникальный в пределах конкретного контрола. */
  id: string;
  /** Категория действия, определяющая форму допустимого input. */
  type: 'click' | 'input' | 'select' | 'toggle' | 'submit' | 'custom';
  /** Человекочитаемое имя действия, если оно нужно для LLM-контекста. */
  label?: string;
  /** Доверенный server-side payload действия; не передаётся LLM. */
  __payload?: Record<string, unknown>;
}

/** Событие пользователя или действие LLM, направленное на интерактивный control. */
export interface UiEvent {
  /** Идентификатор события для backend-корреляции; не передаётся LLM. */
  __eventId: string;
  /** Время возникновения события; не передаётся LLM. */
  __occurredAt: string;
  /** Идентификатор root, в котором следует искать control. */
  rootId: string;
  /** Идентификатор целевого UiControlNode. */
  controlId: string;
  /** Запрошенное действие из allow-list контрола. */
  toolId?: string;
  /** Тип DOM-события или пользовательского действия. */
  type: 'click' | 'input' | 'change' | 'keydown' | 'custom';
  /** Источник события для логов и аудита; не передаётся LLM. */
  __source?: 'user' | 'llm';
  /** Значение, которое требуется передать control-у для input/select действий. */
  value?: string | boolean | number | null;
  /** Дополнительный backend-контекст события; не передаётся LLM. */
  __context?: Record<string, string>;
}

/** Адаптер, который распознаёт DOM-элемент, описывает его и при необходимости выполняет действие. */
export interface ControlHandler {
  /** Тип адаптера для диагностики и регистрации. */
  type: string;
  /** Проверяет, обрабатывает ли адаптер данный DOM-элемент. */
  matches(element: HTMLElement): boolean;
  /** Возвращает описание контрола и его allow-list без выполнения побочных эффектов. */
  parse(element: HTMLElement): ControlDescriptor;
  /** Выполняет разрешённое действие контрола; отсутствие метода запрещает dispatch через handler. */
  dispatch?(element: HTMLElement, event: UiEvent): void;
}

/** Настройки framework-agnostic DOM parser-а. */
export interface ParserOptions {
  /** Атрибуты, значения которых сохраняются в backend-only контексте узла. */
  contextAttributes?: readonly string[];
  /** Атрибуты, явно отмечающие div как значимую UI-группу. */
  groupAttributes?: readonly string[];
}

/** Семантическая ARIA-связь текущего узла с элементами по их HTML id. */
export interface UiRelation {
  /** Тип ARIA-связи, из которой получены targets. */
  type: 'labelledby' | 'controls';
  /** HTML id целевых узлов; сопоставляются с UiNode.domId и передаются LLM. */
  targetDomIds: string[];
  /** Разрешённый текст target-элементов, например доступное имя из labelledby. */
  text?: string;
}