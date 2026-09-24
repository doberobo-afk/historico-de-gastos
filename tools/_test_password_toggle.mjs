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

const html = fs.readFileSync(path.join(RAIZ, "index.html"), "utf8");
const css = fs.readFileSync(path.join(RAIZ, "css", "style.css"), "utf8");
const js = fs.readFileSync(path.join(RAIZ, "js", "app.js"), "utf8");

console.log("1) HTML: wrapper + botoes (IDs preservados)");
for (const id of ["loginSenha", "recSenha", "recSenha2"]) {
  assert(html.includes(`id="${id}"`), `input #${id} preservado`);
}
for (const id of ["toggleLoginSenha", "toggleRecSenha", "toggleRecSenha2"]) {
  assert(html.includes(`id="${id}"`), `botao #${id} existe`);
}
assert((html.match(/class="relative"/g) || []).length >= 3, "3 wrappers .relative");
assert((html.match(/type="button" id="toggle/g) || []).length === 3, "botoes type=button (nao submetem o form)");
assert(html.includes('class="eye-btn"'), "botoes com classe eye-btn");
assert(html.includes('aria-label="Mostrar senha"'), "aria-label inicial Mostrar senha");
assert(html.includes('type="password" id="loginSenha"'), "login comeca como password");

console.log("2) CSS: posicao do olho");
assert(css.includes(".relative { position: relative; }"), ".relative posiciona");
assert(css.includes(".login-card input.pr-10"), "regra .pr-10 existe");
assert(css.includes("padding-right: 2.5rem"), "input reserva espaco (pr-10)");
assert(css.includes(".eye-btn"), "regra .eye-btn existe");
assert(css.includes("position: absolute"), ".eye-btn absoluto a direita");
assert(css.includes("color: #a1a1aa"), ".eye-btn text-zinc-400 equivalente (#a1a1aa)");
assert(css.includes(".eye-btn:hover"), ".eye-btn tem hover");
assert(css.includes("width: 20px; height: 20px"), "icone 20px");

console.log("3) JS: alternancia + foco + aria");
assert(js.includes("function ligarOlhoSenha"), "ligarOlhoSenha existe");
assert(js.includes('input.type === "password" ? "text" : "password"'), "alterna password/text");
assert(js.includes("mousedown") && js.includes("preventDefault"), "mousedown preventDefault (nao perde foco)");
assert(js.includes("input.focus"), "devolve foco ao input");
assert(js.includes('"Mostrar senha"') && js.includes('"Esconder senha"'), "aria-label dinamico Mostrar/Esconder");
assert(js.includes("SVG_OLHO_ABERTO") && js.includes("SVG_OLHO_FECHADO"), "icones Eye/EyeOff");
assert(js.includes('ligarOlhoSenha("loginSenha", "toggleLoginSenha")'), "liga login");
assert(js.includes('ligarOlhoSenha("recSenha", "toggleRecSenha")'), "liga nova senha");
assert(js.includes('ligarOlhoSenha("recSenha2", "toggleRecSenha2")'), "liga confirmacao");
assert(js.includes("dataset.olhoLigado"), "protecao contra duplo listener");

console.log("4) Funcional: simulacao com DOM falso");
{
  const ini = js.indexOf("const SVG_OLHO_ABERTO");
  const fim = js.indexOf('ligarOlhoSenha("loginSenha"');
  const bloco = js.slice(ini, fim);
  const botoes = {};
  const inputs = {
    in1: { type: "password", focus() { this.focada = (this.focada || 0) + 1; } },
  };
  const mkBtn = () => ({
    innerHTML: "", dataset: {}, attrs: {}, handlers: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
  });
  const documentMock = {
    getElementById(id) {
      if (id === "in1") return inputs.in1;
      if (!botoes[id]) botoes[id] = mkBtn();
      return id === "in1" ? inputs.in1 : botoes[id];
    },
  };
  const fn = new Function("document", `${bloco}; ligarOlhoSenha("in1", "btn1"); return document.getElementById("btn1");`);
  const btn = fn(documentMock);
  assert(inputs.in1.type === "password", "comeca oculto");
  assert(btn.innerHTML.includes("<svg"), "icone Eye inicial");
  assert(btn.attrs["aria-label"] === "Mostrar senha", "aria inicial Mostrar senha");
  let def = false;
  btn.handlers.mousedown({ preventDefault() { def = true; } });
  assert(def === true, "mousedown chama preventDefault (mantem foco)");
  btn.handlers.click();
  assert(inputs.in1.type === "text", "1o clique mostra senha");
  assert(btn.attrs["aria-label"] === "Esconder senha", "aria vira Esconder senha");
  assert((inputs.in1.focada || 0) >= 1, "foco devolvido ao input");
  assert(btn.innerHTML.includes("<svg"), "icone EyeOff ao mostrar");
  btn.handlers.click();
  assert(inputs.in1.type === "password", "2o clique oculta de novo");
  assert(btn.attrs["aria-label"] === "Mostrar senha", "aria volta a Mostrar senha");
}

console.log(`\n${total} verificacoes, ${falhas} falha(s)${falhas === 0 ? " SUCESSO!" : ""}\n`);
process.exit(falhas === 0 ? 0 : 1);
