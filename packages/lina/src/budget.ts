/**
 * Бюджет хода диалога (D-021, W1-LINA-04).
 *
 * Что здесь НЕ ограничено: число раундов вопросов. LINA — агент, который должен
 * уметь разговаривать столько, сколько нужно человеку; потолок раундов означал бы
 * обрыв беседы на середине по счётчику, а не по существу.
 *
 * Что ограничено: работа МЕЖДУ двумя сообщениями человека. Реплика человека
 * обнуляет счётчик, потому что дорога не длина беседы, а бесконтрольная работа
 * без участия человека — цикл, в котором агент обращается к модели снова и снова,
 * не получая новых сведений.
 *
 * Два независимых предела:
 *   • число обращений к модели за ход — грубый предохранитель от зацикливания;
 *   • накопленные токены цепочки — мягкий порог, при котором контекст
 *     сворачивается в конспект, и беседа ПРОДОЛЖАЕТСЯ. Это не остановка.
 */
export const CALLS_PER_TURN = 8;
export const CONTEXT_SOFT_LIMIT_TOKENS = 24000;

export interface TurnState {
  calls: number;
  turnTokens: number;
  chainTokens: number;
}

export type BudgetVerdict =
  | { proceed: true; fold: boolean }
  | { proceed: false; reason: string };

/**
 * Можно ли выполнить ещё одно обращение к модели на этом ходу.
 *
 * Исчерпание бюджета — не ошибка и не отказ человеку: ход останавливается,
 * запись остаётся в журнале, а следующая реплика человека начинает новый ход.
 * Мёртвая цепочка не мешает: она просто ждёт.
 */
export function allowModelCall(state: TurnState): BudgetVerdict {
  if (state.calls >= CALLS_PER_TURN) {
    return { proceed: false, reason: `budget.calls_exhausted:${state.calls}/${CALLS_PER_TURN}` };
  }
  return { proceed: true, fold: state.chainTokens >= CONTEXT_SOFT_LIMIT_TOKENS };
}

/** Счётчик хода после обращения к модели. */
export function accountCall(state: TurnState, tokens: number): TurnState {
  return {
    calls: state.calls + 1,
    turnTokens: state.turnTokens + tokens,
    chainTokens: state.chainTokens + tokens,
  };
}

/**
 * Новый ход: счётчик обращений и токены хода обнуляются, накопленные токены
 * цепочки — нет. Цепочка живёт дольше хода, и именно её длина решает,
 * пора ли сворачивать контекст.
 */
export function startTurn(state: TurnState): TurnState {
  return { calls: 0, turnTokens: 0, chainTokens: state.chainTokens };
}

/**
 * Свёртка контекста: конспект плюс последние сообщения дословно.
 *
 * Дословный хвост обязателен: в конспекте теряются формулировки, а последняя
 * реплика человека — это то, на что агент отвечает прямо сейчас.
 */
export interface Message {
  role: "human" | "agent";
  text: string;
}

export interface FoldedContext {
  summary: string;
  tail: Message[];
  foldedCount: number;
}

export function foldContext(
  messages: readonly Message[], summarize: (m: readonly Message[]) => string, tailSize = 6,
): FoldedContext {
  if (messages.length <= tailSize) {
    return { summary: "", tail: [...messages], foldedCount: 0 };
  }
  const head = messages.slice(0, messages.length - tailSize);
  return {
    summary: summarize(head),
    tail: messages.slice(messages.length - tailSize),
    foldedCount: head.length,
  };
}

/**
 * Оценка размера в токенах без обращения к модели.
 *
 * Точное число возвращает сама модель в ответе; эта оценка нужна ДО обращения —
 * чтобы решить, не пора ли свернуть контекст. Заниженная оценка опаснее
 * завышенной, поэтому коэффициент выбран с запасом в меньшую сторону символов
 * на токен.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
