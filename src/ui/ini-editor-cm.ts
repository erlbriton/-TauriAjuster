import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';

/**
 * Потоковый парсер INI для CodeMirror 6.
 * Распознаёт:
 *  - комментарии: строки, начинающиеся с ';' или '#';
 *  - секции:      строки вида [SectionName];
 *  - ключи:       текст до знака '=';
 *  - оператор:    сам знак '=';
 *  - значения:    текст после '=' до конца строки.
 *
 * Возвращает строковые идентификаторы токенов, которые затем стилизуются через тему.
 */
const iniLanguage = StreamLanguage.define<{ seenEquals: boolean }>({
    name: 'ini',
    startState: () => ({ seenEquals: false }),
    token(stream, state) {
        if (stream.sol()) {
            state.seenEquals = false;
            const ch = stream.peek();
            // Комментарий
            if (ch === ';' || ch === '#') {
                stream.skipToEnd();
                return 'comment';
            }
            // Секция
            if (ch === '[') {
                stream.skipTo(']');
                stream.eat(']');
                return 'heading';
            }
        }
        // Знак '='
        if (stream.peek() === '=') {
            stream.next();
            state.seenEquals = true;
            return 'operator';
        }
        // Значение после '='
        if (state.seenEquals) {
            stream.skipToEnd();
            return 'string';
        }
        // Ключ до '='
        if (stream.match(/^[^=\[\];#]+/)) {
            return 'propertyName';
        }
        stream.next();
        return null;
    },
});

/** Цвета токенов INI: маппинг тегов подсветки на стили. */
const iniHighlightStyle = HighlightStyle.define([
    { tag: tags.comment, color: '#6a9955', fontStyle: 'italic' },   // комментарии ; и #
    { tag: tags.heading, color: '#920373', fontWeight: 'bold' },    // секции [Section]
    { tag: tags.propertyName, color: '#310ff3ef' },                 // ключи до '='
    { tag: tags.operator, color: '#dd4b38' },                       // знак '='
    { tag: tags.string, color: '#035303' },                         // значения после '='
]);

/**
 * Оформление редактора: моноширинный шрифт, светлый фон, перенос длинных строк.
 */
const iniTheme = EditorView.theme(
  {
    "&": {
      fontSize: "14px",
      height: "100%",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: 'Consolas, Monaco, "Courier New", monospace',
      lineHeight: "1.5",
    },
    ".cm-content": {
      padding: "8px 0",
      caretColor: "#ff0000 !important",
    },
    ".cm-line": { padding: "0 8px" },

    // Стандартный курсор CodeMirror
    ".cm-cursor": {
      borderLeft: "2px solid black !important",
    },
    // Контейнер ВСЕХ панелей CodeMirror (у нас здесь только шапка поиска Ctrl+F)
    ".cm-panels": {
      backgroundColor: "#f0f0f0", // ИЗМЕНЕНО: Светлый фон шапки поиска для белого редактора
      color: "#333333", // ИЗМЕНЕНО: Тёмный цвет текста внутри шапки
      borderBottom: "1px solid #cccccc", // ИЗМЕНЕНО: Светлая линия внизу шапки
      minHeight: "100px",
      padding: "6px 8px",
    },
    // Поля ввода "Find" и "Replace" (левая колонка шапки)
    ".cm-panel.cm-panel-search input": {
      backgroundColor: "#ffffff", // ИЗМЕНЕНО: Белый фон полей ввода
      color: "#000000", // Цвет текста, который печатает пользователь
      border: "1px solid #999", // Рамка поля ввода
      height: "40px", // ИЗМЕНЕНО: Более компактная высота
      fontSize: "16px", // ИЗМЕНЕНО: Более компактный шрифт
    },
    // Кнопки next / previous / all / replace / replace all
    ".cm-panel.cm-panel-search button": {
      height: "40px", // ИЗМЕНЕНО: Выровнена с полями ввода
      fontSize: "16px", // ИЗМЕНЕНО
    },
  },
  // Флаг светлой темы (убрали dark: true, так как фон белый)
  { dark: false },
);

export interface IniEditorInstance {
    view: EditorView;
    getValue: () => string;
    destroy: () => void;
    focus: () => void;
}

/**
 * Создаёт instance CodeMirror 6 для редактирования INI-файлов.
 * Поддержка: подсветка синтаксиса, нумерация строк, история (Ctrl+Z/Y),
 * поиск (Ctrl+F, F3), подсветка совпадений выделения, автодополнение.
 */
export function createIniEditor(
    container: HTMLElement,
    initialContent: string
): IniEditorInstance {
    const state = EditorState.create({
        doc: initialContent,
        extensions: [
            EditorView.contentAttributes.of({ 
                style: 'caret-color: #ff0000; caret-shape: auto' 
            }),
            lineNumbers(),
            history(),
            iniLanguage,
            syntaxHighlighting(iniHighlightStyle),
            search({ top: true }),
            highlightSelectionMatches(),
            autocompletion(),
            EditorView.lineWrapping,
            keymap.of([
                ...defaultKeymap,
                ...historyKeymap,
                ...completionKeymap,
                ...searchKeymap,
            ]),
            iniTheme,
        ],
    });

    const view = new EditorView({
        state,
        parent: container,
    });

    return {
        view,
        getValue: () => view.state.doc.toString(),
        destroy: () => {
            view.destroy();
            container.innerHTML = '';
        },
        focus: () => view.focus(),
    };
}