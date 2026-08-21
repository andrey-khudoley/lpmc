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
