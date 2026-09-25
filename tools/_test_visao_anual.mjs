// ============================================================================
// Valida a "Visão Anual" DINÂMICA de js/app.js (função renderVisaoAnual).
// ----------------------------------------------------------------------------
// A tabela não é imagem nem tem valores fixos: é a tabela real #tabelaAnual /
// #visaoAnualBody (index.html), preenchida a cada render a partir de
// STATE.cf/STATE.cd. Este teste roda o bloco REAL do app.js num sandbox (mesmo
// estilo de tools/_test_chart_anual_cores.mjs) junto com os somadores reais
// somaCF/somaCD e confere: agregação mês a mês, formato BRL (toLocaleString
// pt-BR), cores exatas por valor/signo, estrutura da tabela e a limpeza de
// <img>/<canvas>/background-image dentro de #visaoAnual.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.dirname(DIR);

let falhas = 0;
let total = 0;
function assert(cond, msg) {
  total++;
  if (cond) console.log(`  ok    ${msg}`);
  else {
    console.error(`  FALHA ${msg}`);
    falhas++;
  }
}

const MESES = [
  "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
  "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
];

const appJs = fs.readFileSync(path.join(RAIZ, "js", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(RAIZ, "index.html"), "utf8");
const css = fs.readFileSync(path.join(RAIZ, "css", "style.css"), "utf8");

console.log("1) O cálculo vive no js/app.js (sem arquivo de valores fixos)");
const iniSomadores = appJs.indexOf("function normalizaTipo(");
const fimSomadores = appJs.indexOf("function renderResumo(");
const iniAnual = appJs.indexOf("// VISÃO ANUAL ");
const fimAnual = appJs.indexOf("// Backup / Reset");
assert(
  iniSomadores !== -1 && fimSomadores > iniSomadores,
  "somaCF/somaCD localizados no app.js",
);
assert(iniAnual !== -1 && fimAnual > iniAnual, "bloco renderVisaoAnual localizado");
assert(
  !fs.existsSync(path.join(RAIZ, "js", "visaoAnual.js")),
  "js/visaoAnual.js (que trazia os valores fixos) foi removido",
);
const somadores = appJs.slice(iniSomadores, fimSomadores);
const anual = appJs.slice(iniAnual, fimAnual);

// Cópias fiéis dos utilitários do app.js usados pelos somadores
function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
function anoDaDataBr(dataBr) {
  if (!dataBr) return "";
  const [, , a] = dataBr.split("/");
  return a;
}
function mesDaDataBr(dataBr) {
  if (!dataBr) return "";
  const [, m] = dataBr.split("/");
  return MESES[parseInt(m, 10) - 1] || "";
}
function brMoeda(v) {
  return num(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
const CATEGORIAS_RECEITA_PADRAO = ["SALÁRIO", "EXTRAS", "OUTRAS RECEITAS"];

assert(
  /function brMoeda\(v\) \{\s*return num\(v\)\.toLocaleString\("pt-BR", \{ style: "currency", currency: "BRL" \}\);\s*\}/.test(
    appJs,
  ),
  "app.js formata com toLocaleString('pt-BR', {style:'currency',currency:'BRL'})",
);

// Sandbox: só os ids da Visão Anual (o resto do app.js não é executado aqui)
function criarSandbox(state, anoSelecionado) {
  const removidos = [];
  const corpo = { style: {}, innerHTML: "" };
  const tabela = { style: {} };
  const wrapper = {
    style: {},
    querySelectorAll: () =>
      ["img", "canvas"].map((tag) => ({
        tag,
        remove() {
          removidos.push(tag);
        },
      })),
  };
  const anoEl = { style: {}, textContent: "", colSpan: 0 };
  const elementos = {
    visaoAnualBody: corpo,
    tabelaAnual: tabela,
    visaoAnual: wrapper,
    vaAno: anoEl,
    resumoAno: { value: anoSelecionado },
  };
  const fn = new Function(
    "document",
    "window",
    "STATE",
    "MESES",
    "num",
    "brMoeda",
    "anoDaDataBr",
    "mesDaDataBr",
    "CATEGORIAS_RECEITA_PADRAO",
    `${somadores}\n${anual}\nreturn { render: window.renderVisaoAnual, va: window.visaoAnual };`,
  );
  const api = fn(
    { getElementById: (id) => elementos[id] || null },
    {},
    state,
    MESES,
    num,
    brMoeda,
    anoDaDataBr,
    mesDaDataBr,
    CATEGORIAS_RECEITA_PADRAO,
  );
  return { api, corpo, tabela, wrapper, anoEl, removidos };
}

// Dados de teste (mesmo formato do Controle Financeiro e do Controle de Dívidas)
const STATE = {
  cf: [
    { TIPO: "SALÁRIO", VALOR: 5000, DATA: "05/01/2026", VENCIMENTO: "JANEIRO", ANO: 2026, ENTRADA_SAIDA: "RECEITA" },
    { TIPO: "SALÁRIO", VALOR: 1000, DATA: "05/02/2026", VENCIMENTO: "FEVEREIRO", ANO: 2026, ENTRADA_SAIDA: "RECEITA" },
    { TIPO: "SALÁRIO", VALOR: 3000, DATA: "05/03/2026", VENCIMENTO: "MARÇO", ANO: 2026, ENTRADA_SAIDA: "RECEITA" },
    { TIPO: "SALÁRIO", VALOR: 1000, DATA: "05/04/2026", VENCIMENTO: "ABRIL", ANO: 2026, ENTRADA_SAIDA: "RECEITA" },
    { TIPO: "SALÁRIO", VALOR: 1000, DATA: "05/05/2026", VENCIMENTO: "MAIO", ANO: 2026, ENTRADA_SAIDA: "RECEITA" },
    { TIPO: "MERCADO", VALOR: 800, DATA: "10/01/2026", VENCIMENTO: "JANEIRO", ANO: 2026, ENTRADA_SAIDA: "DESPESA" },
    { TIPO: "MERCADO", VALOR: 6000, DATA: "10/02/2026", VENCIMENTO: "FEVEREIRO", ANO: 2026, ENTRADA_SAIDA: "DESPESA" },
    { TIPO: "MERCADO", VALOR: 2500, DATA: "10/03/2026", VENCIMENTO: "MARÇO", ANO: 2026, ENTRADA_SAIDA: "DESPESA" },
    { TIPO: "MERCADO", VALOR: 1500, DATA: "10/04/2026", VENCIMENTO: "ABRIL", ANO: 2026, ENTRADA_SAIDA: "DESPESA" },
    // sem ANO/VENCIMENTO: a data (20/06/2026) define junho/2026
    { TIPO: "MERCADO", VALOR: 100, DATA: "20/06/2026", ENTRADA_SAIDA: "DESPESA" },
    // abaixo de 100: fundo verde (mesmo sendo um valor quase nulo); a categoria
    // vem em minúsculas/espaços e precisa casar com "MERCADO"
    { TIPO: " mercado ", VALOR: 50, DATA: "10/07/2026", VENCIMENTO: "JULHO", ANO: 2026, ENTRADA_SAIDA: "DESPESA" },
    // outro ano: não pode entrar na tabela de 2026
    { TIPO: "SALÁRIO", VALOR: 9999, DATA: "05/01/2025", VENCIMENTO: "JANEIRO", ANO: 2025, ENTRADA_SAIDA: "RECEITA" },
    { TIPO: "MERCADO", VALOR: 999, DATA: "10/01/2025", VENCIMENTO: "JANEIRO", ANO: 2025, ENTRADA_SAIDA: "DESPESA" },
  ],
  cd: [
    // parcela que vence em janeiro/2026 (compra feita em dezembro/2025)
    { TIPO: "CARTÃO EXEMPLO", VALOR: 300, DATA: "15/12/2025", VENCIMENTO: "JANEIRO", ANO: "2026", OBSERVACAO: "PARCELADOS" },
    { TIPO: " INTERNET", VALOR: 99.9, DATA: "10/01/2026", VENCIMENTO: "JANEIRO", ANO: "2026", OBSERVACAO: "GASTOS FIXOS" },
    // entrada por recebimento: NÃO é despesa
    { TIPO: "VENDA", VALOR: 400, DATA: "20/12/2025", VENCIMENTO: "JANEIRO", ANO: "2026", OBSERVACAO: "RECEBIDO" },
    { TIPO: "cdc exemplo ", VALOR: 200, DATA: "10/03/2026", VENCIMENTO: "MARÇO", ANO: "2026", OBSERVACAO: "GASTOS FIXOS" },
    // observação com espaços/minúsculas também conta como PARCELADOS
    { TIPO: "CARTÃO EXEMPLO", VALOR: 70, DATA: "15/06/2026", VENCIMENTO: "JUNHO", ANO: "2026", OBSERVACAO: " parcelados " },
    { TIPO: "VENDA", VALOR: 50, DATA: "20/06/2026", VENCIMENTO: "JUNHO", ANO: "2026", OBSERVACAO: "À RECEBER" },
  ],
  cad: {
    gastos_variaveis: ["MERCADO"],
    fixos_parcelados: ["CARTÃO EXEMPLO", "CDC EXEMPLO", " INTERNET", "VENDA"],
    receitas: ["SALÁRIO"],
    receitas_variaveis: ["SALÁRIO"],
  },
  meta: { ano_atual: 2026 },
};

// Lê o HTML gerado e devolve, por rótulo de linha, as 12 células de valor
function linhasTabela(html) {
  const mapa = {};
  html.split("<tr>").forEach((bloco) => {
    const cels = [
      ...bloco.matchAll(
        /<td class="([^"]*)"(?: style="background:([^"]*)")?>([^<]*)<\/td>/g,
      ),
    ].map((m) => ({
      classe: m[1],
      fundo: m[2] || "",
      // o Intl usa espaço não separável depois de "R$": normaliza para poder
      // comparar com as strings legíveis
      valor: m[3].replace(/\u00a0/g, " "),
    }));
    if (cels.length) mapa[cels[0].valor] = cels.slice(1);
  });
  return mapa;
}

const { api, corpo, tabela, wrapper, anoEl, removidos } = criarSandbox(
  STATE,
  "2026",
);

console.log("2) Estrutura: tabela real, sem imagem, com as 6 linhas");
assert(api.render() === true, "renderVisaoAnual() desenha e devolve true");
assert(typeof api.render === "function", "window.renderVisaoAnual exposto ao console");
assert(
  typeof api.va.coletar === "function" && typeof api.va.corGastosVariaveis === "function",
  "visaoAnual.coletar()/corGastosVariaveis() expostos ao console",
);
assert(
  anoEl.textContent === "2026",
  "célula do ano preenchida pelo sistema (não é número fixo no HTML)",
);
assert(anoEl.colSpan === 12, "célula do ano cobre os 12 meses");
assert(removidos.length === 2, "#visaoAnual remove <img>/<canvas> que sobrarem no HTML");
assert(
  wrapper.style.backgroundImage === "none" &&
    tabela.style.backgroundImage === "none" &&
    corpo.style.backgroundImage === "none",
  "nenhum background-image na Visão Anual",
);

const html = corpo.innerHTML;
const linhas = linhasTabela(html);
assert(
  Object.keys(linhas).length === 6,
  `6 linhas (RECEITA..SALDO), há ${Object.keys(linhas).length}`,
);
assert(
  Object.values(linhas).every((c) => c.length === 12),
  "cada linha tem as 12 colunas de mês",
);
assert(/class="va-etiqueta va-receita">RECEITA</.test(html), "etiqueta da linha RECEITA");
assert(
  /class="va-etiqueta va-parcelados">PARCELADOS</.test(html),
  "etiqueta da linha PARCELADOS",
);
assert(/class="va-etiqueta va-fixos">GASTOS FIXOS</.test(html), "etiqueta GASTOS FIXOS");
assert(
  /class="va-etiqueta va-etq">GASTOS VARIÁVEIS</.test(html),
  "etiqueta GASTOS VARIÁVEIS",
);
assert(/class="va-etiqueta va-despesa">DESPESA TOTAL</.test(html), "etiqueta DESPESA TOTAL");
assert(/class="va-etiqueta va-etq">SALDO</.test(html), "etiqueta SALDO");
assert(!/<img|<canvas/.test(html), "nenhum <img>/<canvas> no HTML gerado");

console.log("3) Valores: cálculo automático mês a mês (formato pt-BR)");
assert(linhas.RECEITA[0].valor === "R$ 5.000,00", "JAN: receita do mês");
assert(linhas.RECEITA[11].valor === "R$ 0,00", "DEZ: sem lançamento -> R$ 0,00");
assert(
  linhas.PARCELADOS[0].valor === "R$ 300,00",
  "JAN: parcelados só das dívidas com OBSERVAÇÃO PARCELADOS",
);
assert(
  linhas["GASTOS FIXOS"][0].valor === "R$ 99,90",
  "JAN: gastos fixos do CD (99,90 com vírgula)",
);
assert(
  linhas["GASTOS FIXOS"][2].valor === "R$ 200,00",
  "MAR: gastos fixos do CD (TIPO 'cdc exemplo ' casa com a categoria CDC EXEMPLO)",
);
assert(
  linhas["GASTOS VARIÁVEIS"][0].valor === "R$ 800,00",
  "JAN: gastos variáveis do Controle Financeiro",
);
assert(
  linhas["GASTOS VARIÁVEIS"][5].valor === "R$ 100,00",
  "JUN: usa a DATA quando não há vencimento/ano",
);
assert(
  linhas["DESPESA TOTAL"][0].valor === "R$ 1.199,90",
  "JAN: DESPESA TOTAL = parcelados + fixos + variáveis",
);
assert(linhas["DESPESA TOTAL"][2].valor === "R$ 2.700,00", "MAR: DESPESA TOTAL = 2.500 + 200");
assert(
  linhas["DESPESA TOTAL"][5].valor === "R$ 170,00",
  "JUN: DESPESA TOTAL = 100 (variável) + 70 (parcela)",
);
assert(
  linhas.SALDO[0].valor === "R$ 3.800,10",
  "JAN: SALDO = receita - despesa total (5.000 - 1.199,90)",
);
assert(
  linhas.SALDO[1].valor === "-R$ 5.000,00",
  "FEV: SALDO negativo com o sinal antes do R$",
);
assert(linhas.SALDO[2].valor === "R$ 300,00", "MAR: SALDO = 3.000 - 2.700");
assert(linhas.SALDO[4].valor === "R$ 1.000,00", "MAI: receita sem despesa");
assert(linhas.SALDO[11].valor === "R$ 0,00", "DEZ: sem lançamentos -> saldo R$ 0,00");
assert(!/9\.999/.test(html), "lançamentos de 2025 não entram na tabela de 2026");

console.log("4) Cores por valor/signo (as exatas do print)");
assert(
  linhas["GASTOS VARIÁVEIS"][0].fundo.startsWith("rgb("),
  "JAN (800): faixa 100–2000 em degradê verde -> vermelho",
);
assert(
  linhas["GASTOS VARIÁVEIS"][6].valor === "R$ 50,00" &&
    linhas["GASTOS VARIÁVEIS"][6].fundo === "#7be9a0",
  "JUL (50): ' mercado ' conta como MERCADO e fica verde #7be9a0 (< 100)",
);
assert(
  linhas["GASTOS VARIÁVEIS"][1].fundo === "#ff9a9a",
  "FEV (6.000): vermelho forte #ff9a9a (> 5000)",
);
assert(
  linhas["GASTOS VARIÁVEIS"][2].fundo === "#ffb3b3",
  "MAR (2.500): vermelho claro #ffb3b3 (> 2000)",
);
assert(
  linhas["GASTOS VARIÁVEIS"][3].fundo.startsWith("rgb("),
  "ABR (1.500): faixa intermediária em degradê",
);
assert(linhas["GASTOS VARIÁVEIS"][4].fundo === "#7be9a0", "MAI (0): verde #7be9a0");
assert(linhas["GASTOS VARIÁVEIS"][11].fundo === "#7be9a0", "DEZ (0): verde #7be9a0");
assert(
  linhas.RECEITA[0].fundo === "" && linhas["DESPESA TOTAL"][0].fundo === "",
  "RECEITA/DESPESA TOTAL usam a cor do CSS (por classe), sem style inline",
);
assert(linhas.SALDO[0].classe.includes("va-saldo-pos"), "SALDO > 0 -> va-saldo-pos (verde #4ade80)");
assert(linhas.SALDO[1].classe.includes("va-saldo-neg"), "SALDO < 0 -> va-saldo-neg (vermelho #ff8a8a)");
assert(linhas.SALDO[11].classe.includes("va-saldo-cero"), "SALDO = 0 -> va-saldo-cero (neutro)");
assert(api.va.corGastosVariaveis(0) === "#7be9a0", "corGastosVariaveis(0) = verde");
assert(api.va.corGastosVariaveis(99) === "#7be9a0", "corGastosVariaveis(99) = verde (< 100)");
assert(api.va.corGastosVariaveis(2001) === "#ffb3b3", "corGastosVariaveis(2.001) = #ffb3b3");
assert(
  api.va.corGastosVariaveis(5000) === "#ffb3b3" && api.va.corGastosVariaveis(5001) === "#ff9a9a",
  "limite de 5.000/5.001 (só acima de 5000 é #ff9a9a)",
);
assert(
  api.va.classeSaldo(-1) === "va-saldo-neg" &&
    api.va.classeSaldo(1) === "va-saldo-pos" &&
    api.va.classeSaldo(0) === "va-saldo-cero",
  "classeSaldo por signo",
);

console.log("5) Reatividade e ano");
STATE.cf.push({
  TIPO: "SALÁRIO",
  VALOR: 200,
  DATA: "06/05/2026",
  VENCIMENTO: "MAIO",
  ANO: 2026,
  ENTRADA_SAIDA: "RECEITA",
});
api.render();
assert(
  linhasTabela(corpo.innerHTML).RECEITA[4].valor === "R$ 1.200,00",
  "lançamento novo aparece na tabela no render seguinte",
);
const dados2025 = api.va.coletar("2025");
assert(Math.round(dados2025.receita[0]) === 9999, "coletar(ano) respeita o ano pedido (2025)");
assert(Math.round(dados2025.variaveis[0]) === 999, "gastos variáveis de 2025");
assert(
  /renderVisaoAnual\(\);/.test(
    appJs.slice(appJs.indexOf("function renderResumo("), iniAnual),
  ),
  "renderResumo() chama renderVisaoAnual() (cadastro/edição/exclusão atualizam)",
);

console.log("6) index.html e css/style.css (tabela de verdade, visual do print)");
const blocoAnual = indexHtml.slice(
  indexHtml.indexOf('<h3 style="margin-top:24px;">Visão Anual</h3>'),
  indexHtml.indexOf("</section>", indexHtml.indexOf("Visão Anual")),
);
assert(/<table id="tabelaAnual">/.test(blocoAnual), "index.html tem <table id=\"tabelaAnual\">");
assert(/<tbody id="visaoAnualBody">/.test(blocoAnual), "index.html tem <tbody id=\"visaoAnualBody\">");
assert(/id="visaoAnual"/.test(blocoAnual), "wrapper #visaoAnual");
assert(/class="va-ano" id="vaAno"/.test(blocoAnual), "célula do ano vazia no HTML (o JS preenche)");
assert(
  !/<img/.test(blocoAnual) && !/<canvas/.test(blocoAnual) && !/background-image/.test(blocoAnual),
  "sem <img>/<canvas>/background-image no HTML da Visão Anual",
);
assert(!/visaoAnual\.js/.test(indexHtml), "index.html não carrega mais js/visaoAnual.js");
assert(
  /#tabelaAnual \{\s*width: 100%;\s*min-width: 1200px;\s*border-collapse: collapse;/.test(css),
  "tabela min-width 1200px + border-collapse collapse",
);
assert(/\.visao-anual-wrapper \{\s*overflow-x: auto;/.test(css), "wrapper com overflow-x: auto");
assert(/border: 1px solid #444;/.test(css), "células com border 1px solid #444");
assert(/padding: 6px 8px;/.test(css) && /font-size: 12px;/.test(css), "padding 6px 8px e font-size 12px");
assert(/position: sticky;\s*left: 0;/.test(css), "primeira coluna sticky left: 0");
assert(/background: #2a2a2a; color: #fff/.test(css), "th #2a2a2a com texto branco");
assert(/\.va-ano \{ background: #3a3a3a/.test(css), "célula ANO #3a3a3a");
const paleta = ["#7ec8e3", "#87ceeb", "#f8a9a9", "#ffb3b3", "#ffd8b1", "#ffdab9", "#ff8c42", "#ff9a4d", "#ff8a8a", "#4ade80"];
assert(
  paleta.every((c) => css.includes(c)),
  `paleta completa do print no CSS: ${paleta.join(" ")}`,
);

console.log(`\n${total} verificacoes, ${falhas} falha(s)${falhas === 0 ? " SUCESSO!" : ""}\n`);
process.exit(falhas === 0 ? 0 : 1);