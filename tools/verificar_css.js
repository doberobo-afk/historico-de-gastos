#!/usr/bin/env node
/**
 * Verificação de CSS (usada no desenvolvimento)
 * --------------------------------------------------------------------------
 * Confere se a folha de estilo:
 *   1. não usa "!important";
 *   2. cobre todas as classes usadas no HTML e no JS;
 *   3. informa as classes definidas no CSS que não são mais usadas.
 *
 * Uso: node tools/verificar_css.js [caminho-do-css]
 */
const fs = require("fs");
const path = require("path");

const RAIZ = path.dirname(__dirname);
const CSS = process.argv[2] || path.join(RAIZ, "css", "style.css");
const FONTES = [
  path.join(RAIZ, "index.html"),
  path.join(RAIZ, "js", "app.js"),
];

// Classes aplicadas dinamicamente pelo JS (não aparecem literalmente no markup)
const DINAMICAS = [
  "active",
  "entrada",
  "despesa",
  "pago",
  "apagar",
  "recebido",
  "areceber",
  "positivo",
  "negativo",
  "online",
  "offline",
  "sincronizando",
  "ultima-parcela",
  // classes da tabela "Visão Anual" (#tabelaAnual) aplicadas por
  // renderVisaoAnual() em js/app.js
  "va-rotulo-ano",
  "va-ano",
  "va-mes",
  "va-corner",
  "va-receita",
  "va-parcelados",
  "va-fixos",
  "va-etq",
  "va-despesa",
  "va-saldo-neg",
  "va-saldo-pos",
  "va-saldo-cero",
];

function ler(caminho) {
  return fs.existsSync(caminho) ? fs.readFileSync(caminho, "utf8") : "";
}

const cssOriginal = ler(CSS);
if (!cssOriginal) {
  console.error(`[ERRO] CSS não encontrado: ${CSS}`);
  process.exit(1);
}

// ignora comentários ao medir "!important" e ao listar classes
const css = cssOriginal.replace(/\/\*[\s\S]*?\*\//g, "");

const linhas = cssOriginal.split(/\r?\n/).length;
const important = (css.match(/!important/g) || []).length;

const classesCss = new Set();
for (const m of css.matchAll(/\.(-?[a-zA-Z][\w-]*)/g)) classesCss.add(m[1]);

const classesUsadas = new Set(DINAMICAS);
for (const fonte of FONTES) {
  const texto = ler(fonte);
  for (const m of texto.matchAll(/class=["'`]([^"'`]*)["'`]/g)) {
    m[1]
      .split(/\s+/)
      .filter((c) => /^[a-zA-Z][\w-]*$/.test(c))
      .forEach((c) => classesUsadas.add(c));
  }
  for (const m of texto.matchAll(
    /classList\.(?:add|remove|toggle)\("([^"]+)"/g,
  )) {
    classesUsadas.add(m[1]);
  }
  // atribuições via propriedade: element.className = "minha-classe outra"
  for (const m of texto.matchAll(/\.className\s*=\s*["'`]([^"'`]*)["'`]/g)) {
    m[1]
      .split(/\s+/)
      .filter((c) => /^[a-zA-Z][\w-]*$/.test(c))
      .forEach((c) => classesUsadas.add(c));
  }
}

const faltando = [...classesUsadas].filter((c) => !classesCss.has(c)).sort();
const naoUsadas = [...classesCss]
  .filter((c) => !classesUsadas.has(c) && !DINAMICAS.includes(c))
  .sort();

console.log(`CSS          : ${path.relative(RAIZ, CSS)}`);
console.log(`Linhas       : ${linhas}`);
console.log(`!important   : ${important}`);
console.log(`Classes CSS  : ${classesCss.size}`);
console.log(`Classes usadas: ${classesUsadas.size}`);
console.log(
  `\nSem estilo definido (${faltando.length}): ${faltando.join(", ") || "nenhuma"}`,
);
console.log(
  `Definidas mas sem uso (${naoUsadas.length}): ${naoUsadas.join(", ") || "nenhuma"}`,
);

if (important > 0 || faltando.length > 0) {
  process.exit(1);
}
