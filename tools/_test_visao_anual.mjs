// Valida js/visaoAnual.js: la tabla "Visão Anual" estilo Excel.
// Comprueba los cálculos automáticos (DESPESA TOTAL y SALDO), el formato BRL
// ("R$ 6.114,31" / "-R$ 4.613,16"), el degradé de gastos variables, la clase
// del saldo por signo y el HTML que se inserta en #tabelaAnualExcel.
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

const codigo = fs.readFileSync(path.join(RAIZ, "js", "visaoAnual.js"), "utf8");

// Carga el archivo en un sandbox con document/window simulados. Como
// readyState = "complete", render() se ejecuta en el acto.
function cargar() {
  const capture = { innerHTML: "" };
  const documentMock = {
    readyState: "complete",
    getElementById: (id) => (id === "tabelaAnualExcel" ? capture : null),
    addEventListener() {},
  };
  const windowMock = {};
  const fn = new Function(
    "document",
    "window",
    `${codigo}; return { recalc: window.recalcularAnual, va: window.visaoAnual };`,
  );
  const api = fn(documentMock, windowMock);
  return { api, capture };
}

const { api, capture } = cargar();

console.log("1) Formato BRL");
assert(api.va.brl(6114.31) === "R$ 6.114,31", "brl: R$ 6.114,31 (punta de millar, comma decimal)");
assert(api.va.brl(10727.47) === "R$ 10.727,47", "brl: R$ 10.727,47");
assert(api.va.brl(-4613.16) === "-R$ 4.613,16", "brl negativo: -R$ 4.613,16 (signo antes de la moneda)");
assert(api.va.brl(0) === "R$ 0,00", "brl cero: R$ 0,00");

console.log("2) Cálculo automático (nunca fijo)");
const C = api.va.calcular();
const aprox = (a, b) => Math.abs(a - b) < 0.005;
assert(aprox(C.DESPESA_TOTAL[0], 3034.77 + 1005.5 + 6687.2), "ENE: DESPESA TOTAL = parcelados + fixos + variáveis");
assert(aprox(C.DESPESA_TOTAL[11], 2116.26 + 969.4 + 0), "DIC: DESPESA TOTAL = 3.085,66");
assert(aprox(C.SALDO[0], 6114.31 - 10727.47), "ENE: SALDO = RECEITA - DESPESA TOTAL (negativo)");
assert(aprox(C.SALDO[5], 7150 - 7224.02), "JUN: SALDO ≈ -74,02 (próximo de cero)");
assert(aprox(C.SALDO[8], 8150 - 3212.81), "SET: SALDO positivo 4.937,19");

console.log("3) Degradê de gastos variáveis e color del saldo");
assert(api.va.colorVariavel(0) === "#86efac", "variáveis < 1000 -> verde #86efac (incl. 0)");
assert(api.va.colorVariavel(6687.2) === "#fca5a5", "variáveis > 4000 -> vermelho #fca5a5");
assert(
  api.va.colorVariavel(2625.19).startsWith("rgb(") &&
    ![ "#fca5a5", "#86efac" ].includes(api.va.colorVariavel(2625.19)),
  "variáveis entre 1000 y 4000 -> mezcla vermelho/verde",
);
assert(api.va.claseSaldo(-4613.16) === "va-saldo-neg", "saldo negativo -> va-saldo-neg");
assert(api.va.claseSaldo(4937.19) === "va-saldo-pos", "saldo positivo -> va-saldo-pos");
assert(api.va.claseSaldo(-74.02) === "va-saldo-cero", "saldo próximo de cero -> va-saldo-cero (amarelo)");

console.log("4) HTML generado (#tabelaAnualExcel)");
const h = capture.innerHTML;
assert(/ANO 2026/.test(h), "cabecera ANO 2026");
assert(/colspan="14"/.test(h), "fila ANO 2026 combinada (1 etiqueta + 12 meses + total)");
const ths = (h.match(/<th/g) || []).length;
assert(ths === 14, `14 <th> en la cabecera de meses (esquina + 12 meses + TOTAL), hay ${ths}`);
const trs = (h.match(/<tr/g) || []).length;
assert(trs === 8, `8 filas (ANO + meses + 6 líneas), hay ${trs}`);
assert(/R\$ 10\.727,47/.test(h), "ENE: DESPESA TOTAL R$ 10.727,47 en la tabla");
assert(/-R\$ 4\.613,16/.test(h), "ENE: SALDO -R$ 4.613,16 en la tabla");
assert(/va-receita/.test(h) && /va-parcelados/.test(h) && /va-fixos/.test(h), "filas RECEITA/PARCELADOS/FIXOS con su clase");
assert(/va-despesa/.test(h), "fila DESPESA TOTAL (fondo #fb923c)");
assert(/class="va-cel va-saldo-neg"/.test(h), "celdas de saldo negativo");
assert(/class="va-cel va-saldo-cero"/.test(h), "celdas de saldo próximo de cero (amarelo)");
assert(/style="background:#fca5a5"/.test(h), "gastos variáveis: fondo por valor (vermelho)");
assert(/style="background:#86efac"/.test(h), "gastos variáveis: fondo por valor (verde)");
const mesesCabecera = ["JAN","FEV","MAR","ABR","MAI","JUN","JUL","AGO","SET","OUT","NOV","DEZ"];
assert(
  mesesCabecera.every((m) => h.includes(">" + m + "</th>")),
  "12 encabezados de mes (JAN..DEZ)",
);

console.log("5) recalcularAnual() re-rendera");
const antes = capture.innerHTML.length;
assert(api.recalc() === true, "recalcularAnual() devuelve true");
assert(capture.innerHTML.length > 0 && capture.innerHTML === h, "tras recalcularAnual() la tabla sigue generada");

console.log(`\n${total} verificacoes, ${falhas} falha(s)${falhas === 0 ? " SUCESSO!" : ""}\n`);
process.exit(falhas === 0 ? 0 : 1);