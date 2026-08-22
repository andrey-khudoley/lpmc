// Собирает public/index.html из макета LPMC.dc.html: инжектит React (офлайн-UMD)
// и мост данных (bridge.js) в компонент, копирует support.js и React рядом.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");            // packages/web
const pub = join(root, "public");
const nm = join(root, "..", "..", "node_modules");
mkdirSync(pub, { recursive: true });

let html = readFileSync(join(here, "LPMC.dc.html"), "utf8");
const bridge = readFileSync(join(here, "bridge.js"), "utf8");
const mobile = readFileSync(join(here, "mobile.css"), "utf8");

// 0) Зацепки для мобильной адаптации (у макета нет нужных селекторов) + стили.
html = html.replace('<div style="height:54px;', '<div data-mob="topnav" style="height:54px;');
// Многословные части привилегированного баннера — скрываем на телефоне.
html = html.replace('<span style="color:var(--fg2);">оператор ', '<span data-mob="privinfo" style="color:var(--fg2);">оператор ');
html = html.replace('<span style="color:var(--fg2);">сессия оператора', '<span data-mob="privinfo" style="color:var(--fg2);">сессия оператора');

// Переключатель зон — на телефоне это нижняя навигация под большой палец.
html = html.replace('<div style="display:flex;gap:2px;padding:3px;border:1px solid var(--line);background:var(--surface);">',
  '<div data-mob="zonetabs" style="display:flex;gap:2px;padding:3px;border:1px solid var(--line);background:var(--surface);">');
// Подпись бренда и индикатор потока — вторичны, на узком экране убираем.
html = html.replace('<span style="font-family:\'JetBrains Mono\',monospace;font-size:9.5px;letter-spacing:.14em;color:var(--fg3);text-transform:uppercase;">lina · pact · mita · cita</span>',
  '<span data-role="brandsub" style="font-family:\'JetBrains Mono\',monospace;font-size:9.5px;letter-spacing:.14em;color:var(--fg3);text-transform:uppercase;">lina · pact · mita · cita</span>');
// Полоса фильтров списка задач — одна прокручиваемая лента вместо трёх рядов.
html = html.replace(/<div style="(flex:none;border-bottom:1px solid var\(--line\);padding:10px 22px;display:flex;align-items:center;gap:18px;flex-wrap:wrap;background:var\(--bg\);)"/g,
  '<div data-mob="filters" style="$1"');
// Полоса вкладок раздела («Разрешённые эндпоинты / Необратимость / Правила»):
// на телефоне не влезает — прокручиваем её, а не всю страницу.
html = html.replace('<div style="display:flex;gap:2px;border:1px solid var(--line);background:var(--surface);padding:3px;align-self:flex-start;">',
  '<div data-mob="tabs" style="display:flex;gap:2px;border:1px solid var(--line);background:var(--surface);padding:3px;align-self:flex-start;">');
// Шапки таблиц (ряд подписей колонок) — в карточном виде не нужны.
html = html.replace(/<div style="([^"]*text-transform:uppercase[^"]*)">(\s*)<span data-role="cell">/g,
  '<div data-mob="thead" style="$1">$2<span data-role="cell">');
// Строки таблиц — на телефоне становятся карточками.
html = html.replace(/<div((?:\s+[a-zA-Z-]+="[^"]*")*)\s+style="\{\{ (\w+)\.rowStyle \}\}"/g,
  '<div$1 data-mob="row" style="{{ $2.rowStyle }}"');
// Декоративные «крошки» экранов (01 —— СПИСОК ЗАДАЧ): на телефоне только шум.
html = html.replace(/<span style="display:flex;align-items:center;gap:9px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:\.16em;text-transform:uppercase;color:var\(--fg3\);">/g,
  '<span data-mob="eyebrow" style="display:flex;align-items:center;gap:9px;font-family:\'JetBrains Mono\',monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--fg3);">');
// Мастер и карточка задачи — на телефоне во весь экран.
html = html.replace('<div style="{{ wizard.panelStyle }}"', '<div data-mob="wizard" style="{{ wizard.panelStyle }}"');
html = html.replace('<div data-screen-label="01 Задача · карточка"', '<div data-mob="cardmodal" data-screen-label="01 Задача · карточка"');

html = html.replace("</head>", "<style>\n" + mobile + "\n</style>\n</head>");

// 1) React перед support.js
html = html.replace('<script src="./support.js"></script>',
  '<script src="react.production.min.js"></script>\n'
  + '<script src="react-dom.production.min.js"></script>\n'
  + '<script src="support.js"></script>');

// 2) Мост — в конец data-dc-script (Component уже определён).
html = html.replace(/(<script[^>]*\bdata-dc-script\b[^>]*>)([\s\S]*?)(<\/script>)/,
  (m, open, body, close) => open + body + "\n/* --- live bridge --- */\n" + bridge + "\n" + close);

writeFileSync(join(pub, "index.html"), html);
copyFileSync(join(here, "support.js"), join(pub, "support.js"));
copyFileSync(join(nm, "react", "umd", "react.production.min.js"), join(pub, "react.production.min.js"));
copyFileSync(join(nm, "react-dom", "umd", "react-dom.production.min.js"), join(pub, "react-dom.production.min.js"));
console.log("public/index.html собран из макета + мост; ассеты скопированы");
