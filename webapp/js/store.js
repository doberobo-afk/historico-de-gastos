// ==========================================================================
// HGStore - utilitários de segurança + camada de persistência
// --------------------------------------------------------------------------
// Segurança  : safeParse() (JSON nunca derruba a aplicação) e esc() (escape
//              de HTML para tudo que vem do usuário/planilha)
// Persistência: fetch('/api/sync') -> Vercel Function -> Supabase
//              fallback automático para localStorage (offline/demo/file://)
// ==========================================================================
(function (global) {
  "use strict";

  // Mesmas chaves usadas como cache local (compatível com versões antigas)
  var CHAVES = {
    cf: "hg_controle_financeiro",
    cd: "hg_controle_dividas",
    cad: "hg_cadastros",
    meta: "hg_meta",
  };
  var CAMPOS = ["cf", "cd", "cad", "meta"];
  var API = "/api/sync";
  var TIMEOUT_MS = 6000; // não deixa a tela "presa" esperando a nuvem
  var DEBOUNCE_MS = 900; // agrupa várias alterações em um único POST

  var estado = {
    modo: "local", // "nuvem" | "local"
    usuario: "demo",
    erro: null,
    ultimaSync: null,
    pendente: false,
  };

  var espelho = { cf: [], cd: [], cad: {}, meta: {} }; // último estado conhecido
  var pendentes = {}; // campos alterados aguardando envio
  var timerPush = null;
  var ouvintes = [];

  // ---------------------------------------------------------------------
  // Utilitários de segurança
  // ---------------------------------------------------------------------
  function safeParse(texto, padrao) {
    if (texto === null || texto === undefined) return padrao;
    if (typeof texto === "object") return texto;
    var s = String(texto).trim();
    if (!s) return padrao;
    try {
      var valor = JSON.parse(s);
      return valor === null || valor === undefined ? padrao : valor;
    } catch (e) {
      console.warn("[HGStore] JSON inválido ignorado:", e.message);
      return padrao;
    }
  }

  function esc(valor) {
    if (valor === null || valor === undefined) return "";
    return String(valor)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Converte número/string (BR "1.234,56" ou US "1234.56") sem retornar NaN
  function num(valor) {
    if (typeof valor === "number") return isFinite(valor) ? valor : 0;
    if (valor === null || valor === undefined) return 0;
    var s = String(valor).replace(/R\$|\s|\u00a0/g, "");
    if (!s) return 0;
    var temVirgula = s.indexOf(",") !== -1;
    var temPonto = s.indexOf(".") !== -1;
    var decimal = temVirgula && temPonto
      ? (s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".")
      : (temVirgula ? "," : ".");
    if (decimal === ",") s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  // ---------------------------------------------------------------------
  // Cache local (offline/demo)
  // ---------------------------------------------------------------------
  function chaveLocal(chave) {
    try {
      return global.localStorage.getItem(chave);
    } catch (e) {
      return null; // navegador em modo privado / storage bloqueado
    }
  }

  function lerLocal() {
    return {
      cf: safeParse(chaveLocal(CHAVES.cf), []),
      cd: safeParse(chaveLocal(CHAVES.cd), []),
      cad: safeParse(chaveLocal(CHAVES.cad), {}),
      meta: safeParse(chaveLocal(CHAVES.meta), {}),
    };
  }

  function gravarLocal(dados) {
    CAMPOS.forEach(function (campo) {
      try {
        global.localStorage.setItem(CHAVES[campo], JSON.stringify(dados[campo]));
      } catch (e) {
        console.warn("[HGStore] não foi possível gravar o cache local:", e.message);
      }
    });
  }

  function limparLocal() {
    CAMPOS.forEach(function (campo) {
      try {
        global.localStorage.removeItem(CHAVES[campo]);
      } catch (e) {
        /* ignora */
      }
    });
  }


  // ---------------------------------------------------------------------
  // Semente (exemplos fictícios) - usada quando não há dados
  // ---------------------------------------------------------------------
  function semente() {
    var exemplos = global.DADOS_INICIAIS || {};
    return {
      cf: exemplos.controle_financeiro || [],
      cd: exemplos.controle_dividas || [],
      cad: exemplos.cadastros || {},
      meta: exemplos.resumo_meta || {},
    };
  }

  function normalizar(dados) {
    var d = dados && typeof dados === "object" ? dados : {};
    return {
      cf: Array.isArray(d.controle_financeiro) ? d.controle_financeiro : [],
      cd: Array.isArray(d.controle_dividas) ? d.controle_dividas : [],
      cad: d.cadastros && typeof d.cadastros === "object" ? d.cadastros : {},
      meta: d.resumo_meta && typeof d.resumo_meta === "object" ? d.resumo_meta : {},
    };
  }

  function temDados(dados) {
    return !!(dados && (dados.cf.length || dados.cd.length));
  }

  function serializar(dados) {
    return {
      usuario: estado.usuario,
      dados: {
        controle_financeiro: dados.cf || [],
        controle_dividas: dados.cd || [],
        cadastros: dados.cad || {},
        resumo_meta: dados.meta || {},
      },
    };
  }

  // ---------------------------------------------------------------------
  // Comunicação com /api/sync
  // ---------------------------------------------------------------------
  function requisitar(metodo, corpo) {
    var controlador =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controlador
      ? global.setTimeout(function () {
          controlador.abort();
        }, TIMEOUT_MS)
      : null;

    return global
      .fetch(API, {
        method: metodo,
        headers: {
          "Content-Type": "application/json",
          "X-Usuario": estado.usuario,
        },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: controlador ? controlador.signal : undefined,
      })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .finally(function () {
        if (timer) global.clearTimeout(timer);
      });
  }

  function status() {
    return {
      modo: estado.modo,
      usuario: estado.usuario,
      erro: estado.erro,
      pendente: estado.pendente,
      ultimaSync: estado.ultimaSync,
    };
  }

  function emitir() {
    ouvintes.forEach(function (cb) {
      try {
        cb(status());
      } catch (e) {
        console.warn("[HGStore] ouvinte falhou:", e.message);
      }
    });
  }

  // ---------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------
  function definirUsuario(usuario) {
    var limpo = String(usuario || "").trim();
    if (limpo) estado.usuario = limpo;
    return estado.usuario;
  }

  // Carrega da nuvem; se a nuvem não existir/responder, usa o cache local
  // e, se também não houver nada, publica os exemplos fictícios.
  function load() {
    var local = lerLocal();
    return requisitar("GET")
      .then(function (resp) {
        var dados = normalizar(resp && resp.dados);
        estado.modo = "nuvem";
        estado.erro = null;
        if (!temDados(dados)) {
          // Primeiro acesso: publica a semente de exemplos
          dados = semente();
          espelho = dados;
          gravarLocal(dados);
          return requisitar("POST", serializar(dados)).then(function () {
            estado.ultimaSync = new Date().toISOString();
            emitir();
            return dados;
          });
        }
        espelho = dados;
        gravarLocal(dados);
        estado.ultimaSync = new Date().toISOString();
        emitir();
        return dados;
      })
      .catch(function (e) {
        estado.modo = "local";
        estado.erro = e && e.message ? e.message : "indisponível";
        var dados = temDados(local) ? local : semente();
        espelho = dados;
        if (!temDados(local)) gravarLocal(dados);
        emitir();
        return dados;
      });
  }

  // Grava no cache local e agenda o envio para /api/sync (debounce)
  function save(chaveLS, valor) {
    var campo = null;
    CAMPOS.forEach(function (c) {
      if (CHAVES[c] === chaveLS) campo = c;
    });
    if (!campo) return; // chave desconhecida: ignora

    espelho[campo] = valor;
    pendentes[campo] = valor;

    try {
      global.localStorage.setItem(chaveLS, JSON.stringify(valor));
    } catch (e) {
      /* cache local é opcional */
    }

    if (estado.modo !== "nuvem") return;
    estado.pendente = true;
    emitir();
    if (timerPush) global.clearTimeout(timerPush);
    timerPush = global.setTimeout(push, DEBOUNCE_MS);
  }

  function push() {
    if (estado.modo !== "nuvem") return Promise.resolve(false);
    var dados = {
      cf: pendentes.cf !== undefined ? pendentes.cf : espelho.cf,
      cd: pendentes.cd !== undefined ? pendentes.cd : espelho.cd,
      cad: pendentes.cad !== undefined ? pendentes.cad : espelho.cad,
      meta: pendentes.meta !== undefined ? pendentes.meta : espelho.meta,
    };
    return requisitar("POST", serializar(dados))
      .then(function () {
        pendentes = {};
        estado.pendente = false;
        estado.erro = null;
        estado.ultimaSync = new Date().toISOString();
        emitir();
        return true;
      })
      .catch(function (e) {
        estado.erro = e && e.message ? e.message : "falha ao sincronizar";
        estado.modo = "local"; // segue funcionando offline
        emitir();
        return false;
      });
  }

  // Apaga tudo (nuvem + cache) e volta para os exemplos fictícios
  function reset() {
    limparLocal();
    pendentes = {};
    var sementeDados = semente();
    espelho = sementeDados;

    if (estado.modo !== "nuvem") {
      gravarLocal(sementeDados);
      estado.ultimaSync = null;
      emitir();
      return Promise.resolve(sementeDados);
    }
    return requisitar("DELETE")
      .then(function () {
        return requisitar("POST", serializar(sementeDados));
      })
      .then(function () {
        gravarLocal(sementeDados);
        estado.pendente = false;
        estado.ultimaSync = new Date().toISOString();
        emitir();
        return sementeDados;
      })
      .catch(function (e) {
        estado.erro = e && e.message ? e.message : "falha ao restaurar";
        estado.modo = "local";
        gravarLocal(sementeDados);
        emitir();
        return sementeDados;
      });
  }

  function onChange(cb) {
    if (typeof cb === "function") {
      ouvintes.push(cb);
      cb(status());
    }
    return function () {
      ouvintes = ouvintes.filter(function (o) {
        return o !== cb;
      });
    };
  }

  global.HGStore = {
    CHAVES: CHAVES,
    API: API,
    safeParse: safeParse,
    esc: esc,
    num: num,
    definirUsuario: definirUsuario,
    load: load,
    save: save,
    push: push,
    reset: reset,
    status: status,
    onChange: onChange,
  };
})(window);
