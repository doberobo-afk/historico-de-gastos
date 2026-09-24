import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.dirname(DIR);

let falhas = 0, total = 0;
function assert(cond, msg) {
  total++;
  if (cond) console.log(`  ok    ${msg}`);
  else { console.error(`  FALHA ${msg}`); falhas++; }
}

console.log("1) Regras CSS scroll horizontal");
const css = fs.readFileSync(path.join(RAIZ, "css", "style.css"), "utf8");

assert(css.includes(".grafico-scroll-wrapper"), "classe wrapper existe");
assert(css.includes("overflow-x: auto"), "wrapper tem overflow-x auto");
assert(css.includes("min-width: 600px"), "container min-width 600px desktop");
assert(css.includes("min-width: 650px"), "container 650px no mobile");
assert(css.includes("overflow-x: visible"), "desktop sem scroll");
assert(css.includes("arraste para ver mais"), "dica de scroll no mobile");

console.log("1b) HTML envolve canvas no wrapper");
const html = fs.readFileSync(path.join(RAIZ, "index.html"), "utf8");
assert(html.includes('class="grafico-scroll-wrapper"'), "wrapper no HTML");
assert(html.includes('class="grafico-canvas-container"'), "container no HTML");
assert(html.includes('id="chartAnual"'), "chartAnual presente");
assert(html.includes('id="chartCategorias"'), "chartCategorias presente");

console.log("2) Funcoes JS responsivas");
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
    getComputedStyle: (el) => el._computedStyle || { height: "360px" },
  };
  const ctxMock = {
    setTransform() {}, clearRect() {},
    measureText: (t) => ({ width: t.length * 7 }),
  };
  const fn = new Function("window", `${codigo}; return { ALTURA_GRAFICO_PADRAO, alturaCanvasCss, encurtarTexto, limparCanvas };`);
  return { windowMock, ctxMock, modulo: fn(windowMock) };
}

// 2a: Desktop (container 600px)
{
  const { ctxMock, modulo } = criarAmbiente(1);
  const canvas = { clientWidth: 600, clientHeight: 360, dataset: {}, getAttribute: () => null, style: {} };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(dim.w === 600 && dim.h === 360, "desktop: w=600, h=360");
  assert(canvas.width === 600 && canvas.height === 360, "desktop: buffer dpr=1 igual as dimensoes");
  assert(!canvas.style.height, "desktop: nao fixa height inline quando CSS define clientHeight");
}

// 2b: Mobile (container 650px, sem espremer)
{
  const { ctxMock, modulo } = criarAmbiente(3);
  const canvas = { clientWidth: 650, clientHeight: 340, dataset: {}, getAttribute: () => null, style: {} };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(dim.w === 650 && dim.h === 340, "mobile: mantem largura original 650px");
  assert(canvas.width === 1950 && canvas.height === 1020, "mobile: buffer escalado por dpr=3");
  assert(!canvas.style.height, "mobile: nao fixa height inline (CSS manda)");
}

// 2c: Canvas escondido
{
  const { ctxMock, modulo } = criarAmbiente(2);
  const canvas = {
    clientWidth: 0,
    clientHeight: 0,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    _computedStyle: { height: "340px" },
    dataset: {},
    getAttribute: () => null,
    style: {},
  };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(dim.h === 340, "escondido: resolve altura pelo getComputedStyle");
  assert(!canvas.style.height, "escondido: nao grava inline persistente");
}

// 2d: encurtarTexto
{
  const { ctxMock, modulo } = criarAmbiente(1);
  const curto = modulo.encurtarTexto(ctxMock, "Apenas 50%", 200);
  assert(curto === "Apenas 50%", "encurtarTexto: preserva quando cabe");
  const longo = modulo.encurtarTexto(ctxMock, "DESPESAS COM EDUCACAO E CURSOS 45%", 70);
  assert(longo.endsWith("…") && ctxMock.measureText(longo).width <= 70, "encurtarTexto: encurta com reticencia");
}

console.log("3) Listeners de resize e orientacao");
assert(/window\.addEventListener\(\s*["']resize["']\s*,\s*redesenharGraficosResponsivos\s*\)/.test(appJs), "addEventListener('resize')");
assert(/window\.addEventListener\(\s*["']orientationchange["']\s*,\s*redesenharGraficosResponsivos\s*\)/.test(appJs), "addEventListener('orientationchange')");

console.log(`\n${total} verificacoes, ${falhas} falha(s)${falhas === 0 ? " SUCESSO!" : ""}\n`);
process.exit(falhas === 0 ? 0 : 1);

