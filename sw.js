// ==========================================================================
// Service Worker (PWA) - Controle Financeiro
// --------------------------------------------------------------------------
// Estratégia:
//   • arquivos estáticos (HTML/CSS/JS/ícones) -> cache primeiro, com
//     atualização em segundo plano (stale-while-revalidate);
//   • navegação -> rede primeiro, caindo para a versão em cache (offline);
//   • /api/*    -> sempre rede (dados financeiros não podem ficar velhos).
// ==========================================================================
const VERSAO = "hg-v1";
const CACHE = `controle-financeiro-${VERSAO}`;

const SHELL = [
  "./",
  "./controleFinanceiro.html",
  "./manifest.json",
  "./css/style.css",
  "./js/store.js",
  "./js/dados_iniciais.js",
  "./js/app.js",
  "./icons/icon-192.png",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        Promise.all(
          SHELL.map((url) =>
            cache.add(url).catch(() => {
              /* um arquivo ausente não invalida a instalação */
            }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((chaves) =>
        Promise.all(
          chaves
            .filter((chave) => chave !== CACHE)
            .map((chave) => caches.delete(chave)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (evento) => {
  const requisicao = evento.request;
  const url = new URL(requisicao.url);

  if (requisicao.method !== "GET" || url.origin !== self.location.origin) return;

  // Dados financeiros: sempre da rede
  if (url.pathname.startsWith("/api/")) {
    evento.respondWith(
      fetch(requisicao).catch(
        () =>
          new Response(
            JSON.stringify({ ok: false, modo: "local", erro: "sem conexão" }),
            {
              status: 503,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            },
          ),
      ),
    );
    return;
  }

  // Navegação: rede primeiro, cache como reserva (funciona offline)
  if (requisicao.mode === "navigate") {
    evento.respondWith(
      fetch(requisicao)
        .then((resposta) => {
          const copia = resposta.clone();
          caches.open(CACHE).then((cache) => cache.put(requisicao, copia));
          return resposta;
        })
        .catch(() =>
          caches
            .match(requisicao)
            .then((emCache) => emCache || caches.match("./controleFinanceiro.html")),
        ),
    );
    return;
  }

  // Estáticos: cache primeiro + revalidação em segundo plano
  evento.respondWith(
    caches.match(requisicao).then((emCache) => {
      const daRede = fetch(requisicao)
        .then((resposta) => {
          if (resposta && resposta.status === 200) {
            const copia = resposta.clone();
            caches.open(CACHE).then((cache) => cache.put(requisicao, copia));
          }
          return resposta;
        })
        .catch(() => emCache);
      return emCache || daRede;
    }),
  );
});
