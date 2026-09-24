/**
 * Teste automatizado de responsividade dos gráficos
 * Execução: node tools/_test_chart_responsivo.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.dirname(__dirname);

let falhas = 0, total = 0;
function assert(cond, msg) {
  total++;
  if (cond) console.log(`  ok    ${msg}`);
  else { console.error(`  FALHA ${msg}`); falhas++; }
}

console.log("\n1) Regras CSS de responsividade");
const css = fs.readFileSync(path.join(RAIZ, "css", "style.css"), "utf8");

assert(/\.grid-2\s*>\s*\*\s*\{\s*min-width:\s*0/m.test(css), ".grid-2 > * tem min-width: 0");
assert(/\.chart-box\s+canvas\s*\{[^}]*width:\s*100%/m.test(css), ".chart-box canvas tem width: 100%");
assert(/canvas\s*\{[^}]*max-width:\s*100%/m.test(css), "canvas tem max-width: 100%");
assert(/\.card\s*\{[^}]*overflow:\s*hidden/m.test(css), ".card tem overflow: hidden");
assert(/@media\s*\(\s*max-width:\s*768px\s*\)[\s\S]*?\.grid-2\s*\{[^}]*grid-template-columns:\s*1fr/m.test(css), "@media (max-width: 768px) empilha .grid-2 em 1 col");
assert(/@media\s*\(\s*max-width:\s*768px\s*\)[\s\S]*?#chartCategorias\s*\{[^}]*min-height:\s*320px/m.test(css), "#chartCategorias min-height >= 320px");
assert(/@media\s*\(\s*max-width:\s*768px\s*\)[\s\S]*?#chartAnual\s*\{[^}]*min-height:\s*280px/m.test(css), "#chartAnual min-height >= 280px");

console.log("\n2) Funções JS responsivas");
const appJs = fs.readFileSync(path.join(RAIZ, "js", "app.js"), "utf8");
const mIni = "// == GRAFICOS-RESPONSIVOS (inicio) ==";
const mFim = "// == GRAFICOS-RESPONSIVOS (fim) ==";
const posIni = appJs.indexOf(mIni);
const posFim = appJs.indexOf(mFim);
assert(posIni !== -1 && posFim > posIni, "bloco responsivo delimitado no js/app.js");

const codigo = appJs.slice(posIni + mIni.length, posFim);
function criarAmbiente(dpr = 1) {
  const windowMock = {
    devicePixelRatio: dpr,
    getComputedStyle: (el) => el._computedStyle || { height: "350px" },
  };
  const ctxMock = {
    setTransform() {}, clearRect() {},
    measureText: (t) => ({ width: t.length * 7 }),
  };
  const fn = new Function("window", `${codigo}; return { ALTURA_GRAFICO_PADRAO, alturaCanvasCss, encurtarTexto, limparCanvas };`);
  return { windowMock, ctxMock, modulo: fn(windowMock) };
}

// 2a: Desktop
{
  const { ctxMock, modulo } = criarAmbiente(1);
  const canvas = { clientWidth: 550, clientHeight: 350, dataset: {}, getAttribute: () => null, style: {} };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(dim.w === 550 && dim.h === 350, "desktop: w=550, h=350");
  assert(canvas.width === 550 && canvas.height === 350, "desktop: buffer dpr=1 igual às dimensões");
  assert(!canvas.style.height, "desktop: não fixa height inline quando CSS define clientHeight");
}

// 2b: Mobile
{
  const { ctxMock, modulo } = criarAmbiente(3);
  const canvas = { clientWidth: 300, clientHeight: 340, dataset: {}, getAttribute: () => null, style: {} };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(dim.w === 300 && dim.h === 340, "mobile: dimensões respeitam a media query");
  assert(canvas.width === 900 && canvas.height === 1020, "mobile: buffer escalado por dpr=3");
  assert(!canvas.style.height, "mobile: não fixa height inline (CSS manda)");
}

// 2c: Canvas escondido
{
  const { ctxMock, modulo } = criarAmbiente(2);
  const canvas = {
    clientWidth: 0,
    clientHeight: 0,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    _computedStyle: { height: "300px" },
    dataset: {},
    getAttribute: () => null,
    style: {},
  };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(dim.h === 300, "escondido: resolve altura pelo getComputedStyle");
  assert(!canvas.style.height, "escondido: não grava inline persistente");
}

// 2d: encurtarTexto
{
  const { ctxMock, modulo } = criarAmbiente(1);
  const curto = modulo.encurtarTexto(ctxMock, "Apenas — 50%", 200);
  assert(curto === "Apenas — 50%", "encurtarTexto: preserva quando cabe");
  const longo = modulo.encurtarTexto(ctxMock, "DESPESAS COM EDUCAÇÃO E CURSOS — 45%", 70);
  assert(longo.endsWith("…") && ctxMock.measureText(longo).width <= 70, `encurtarTexto: encurta com '…' ("${longo}")`);
}

console.log("\n3) Listeners de resize e orientação");
assert(/window\.addEventListener\(\s*["']resize["']\s*,\s*redesenharGraficosResponsivos\s*\)/.test(appJs), "addEventListener('resize')");
assert(/window\.addEventListener\(\s*["']orientationchange["']\s*,\s*redesenharGraficosResponsivos\s*\)/.test(appJs), "addEventListener('orientationchange')");

console.log(`\n${total} verificações, ${falhas} falha(s)${falhas === 0 ? " — SUCESSO!" : ""}\n`);
process.exit(falhas === 0 ? 0 : 1);
