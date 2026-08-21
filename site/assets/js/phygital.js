/* ==========================================================================
   PHYGITAL BRASIL — COMPORTAMENTOS DE INTERFACE
   Sem dependências externas. Tudo é progressivo: se um bloco não existe
   na página, o inicializador simplesmente não faz nada.
   ========================================================================== */
(function (global, doc) {
  'use strict';

  var PB = global.PB = global.PB || {};

  var $ = function (sel, ctx) { return (ctx || doc).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };
  var reduzirMovimento = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------------
     GUARDA DE SESSÃO

     Roda no topo do arquivo, e não em iniciar(): este script é carregado antes
     do script inline de cada página, então a saída acontece antes de a página
     tentar montar a tela com dados que não existem.

     Só vale no modo api. No modo local (GitHub Pages) não há sessão de verdade
     e a demonstração precisa continuar navegável.
     --------------------------------------------------------------------- */
  /* Por AREA, nao por nome de arquivo. A lista unica deixava /admin/index.html
     passar pela isencao que existia so para a splash de /painel/index.html — e o
     painel administrativo inteiro abria para quem nao entrou. */
  var PAGINAS_ABERTAS = {
    painel: [
      'login.html', 'cadastro.html', 'recuperar-senha.html',
      'verificar-email.html', 'primeiro-acesso.html',
      /* splash: decide sozinha para onde mandar */
      'index.html'
    ],
    admin: []
  };

  function guardarSessao() {
    if (!PB.dados || typeof PB.dados.modo !== 'function' || PB.dados.modo() !== 'api') return false;

    var caminho = global.location.pathname;
    var area = /\/admin\//.test(caminho) ? 'admin'
      : (/\/painel\//.test(caminho) ? 'painel' : null);
    if (!area) return false;

    var arquivo = caminho.split('/').pop() || 'index.html';
    if ((PAGINAS_ABERTAS[area] || []).indexOf(arquivo) >= 0) return false;

    var conta = PB.dados.sessao && PB.dados.sessao();

    /* Sessão de QUALQUER papel não serve para QUALQUER área. Enquanto a
       checagem era só "tem sessão?", um competidor logado abria o Painel do
       Administrador inteiro: sem vazar dado, porque a API responde 403, mas com
       a casca toda na tela e três páginas estourando erro por ler lista vazia.

       Quem está na área errada vai para a própria, não para o login: mandar
       para o login quem já entrou é pedir a senha de novo sem motivo. */
    if (conta) {
      var ehAdmin = conta.papel === 'admin';
      if (ehAdmin === (area === 'admin')) return false;

      global.location.replace(ehAdmin ? '../admin/index.html' : '../painel/inicio.html');
      return true;
    }

    /* A querystring entra no retorno: sem ela, quem clicou em
       time-detalhe.html?id=t1 voltaria para a ficha de time nenhuma. */
    var alvo = caminho + global.location.search;

    /* replace, não href: a página protegida não fica no histórico, então o
       botão voltar do navegador não volta para uma tela sem dados. */
    var destino = area === 'admin' ? '../painel/login.html' : 'login.html';
    global.location.replace(destino + '?retorno=' + encodeURIComponent(alvo));
    return true;
  }

  /* ---------------------------------------------------------------------
     RETORNO PÓS-LOGIN

     Aceita SÓ caminho deste site. O valor chega pela barra de endereços, ou
     seja, é escrito por quem manda o link — e o login redireciona para ele
     depois de autenticar. Sem esta checagem, '?retorno=https://clone.exemplo'
     transformaria a tela de login num redirecionador aberto: o endereço que a
     vítima confere antes de clicar é o nosso, o destino não. Vetor clássico de
     phishing de credencial.

     Barrado, então: qualquer coisa que não comece em '/' (endereço absoluto de
     outro domínio) e qualquer '//' ou '/\' logo no início — as duas formas que
     o navegador lê como "outro host, mesmo esquema". Sobrando só um caminho
     que começa com uma barra e continua com outra coisa, não há como escapar
     da nossa origem.

     Devolve o caminho aprovado, ou null para quem chamou usar o padrão.
     --------------------------------------------------------------------- */
  function retornoInterno(bruto) {
    if (!bruto) return null;
    var alvo = String(bruto);

    if (alvo.charAt(0) !== '/') return null;
    if (alvo.charAt(1) === '/' || alvo.charAt(1) === '\\') return null;

    /* Só ASCII imprimível, e sem espaço: o navegador descarta tabulação e
       quebra de linha ANTES de resolver o endereço, então uma checagem feita
       apenas sobre o texto deixaria passar algo que vira outro host depois.
       Caminho de página nossa nunca tem espaço nem caractere de controle. */
    if (!/^[!-~]+$/.test(alvo)) return null;

    return alvo;
  }
  PB.retornoInterno = retornoInterno;

  var saindo = guardarSessao();

  /* ---------------------------------------------------------------------
     FORMATADORES
     --------------------------------------------------------------------- */
  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  var MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  var fmt = {
    data: function (iso) {
      if (!iso) return '';
      var p = String(iso).split('-');
      if (p.length < 3) return iso;
      return p[2].substring(0, 2) + '/' + p[1] + '/' + p[0];
    },
    dataExtenso: function (iso) {
      if (!iso) return '';
      var p = String(iso).split('-');
      if (p.length < 3) return iso;
      return parseInt(p[2], 10) + ' de ' + MESES_LONGOS[parseInt(p[1], 10) - 1] + ' de ' + p[0];
    },
    dataCurta: function (iso) {
      if (!iso) return '';
      var p = String(iso).split('-');
      if (p.length < 3) return iso;
      return parseInt(p[2], 10) + ' ' + MESES[parseInt(p[1], 10) - 1] + ' ' + p[0];
    },
    periodo: function (ini, fim) {
      if (!fim || ini === fim) return fmt.dataCurta(ini);
      var a = String(ini).split('-'), b = String(fim).split('-');
      if (a[1] === b[1] && a[0] === b[0]) {
        return parseInt(a[2], 10) + '–' + parseInt(b[2], 10) + ' ' + MESES[parseInt(a[1], 10) - 1] + ' ' + a[0];
      }
      return fmt.dataCurta(ini) + ' – ' + fmt.dataCurta(fim);
    },
    moeda: function (v) {
      return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    numero: function (v) { return Number(v || 0).toLocaleString('pt-BR'); },
    telefone: function (v) {
      var d = String(v || '').replace(/\D/g, '').substring(0, 11);
      if (d.length <= 2) return d;
      if (d.length <= 6) return '(' + d.substring(0, 2) + ') ' + d.substring(2);
      if (d.length <= 10) return '(' + d.substring(0, 2) + ') ' + d.substring(2, 6) + '-' + d.substring(6);
      return '(' + d.substring(0, 2) + ') ' + d.substring(2, 7) + '-' + d.substring(7);
    },
    iniciais: function (nome) {
      var p = String(nome || '').trim().split(/\s+/);
      /* Só pedaços que começam com letra ou número. Sem isto, o avatar de
         "Administração (demonstração)" sai como "A(" — o parêntese conta como
         se fosse a inicial do sobrenome. Se sobrar nada, volta à lista bruta:
         avatar feio ainda é melhor que avatar vazio. */
      var uteis = p.filter(function (x) { return /^[0-9A-Za-zÀ-ÿ]/.test(x); });
      if (uteis.length) p = uteis;
      return ((p[0] || '')[0] || '' ).toUpperCase() + ((p[p.length - 1] || '')[0] || '').toUpperCase();
    },
    diasAte: function (iso) {
      if (!iso) return 0;
      var alvo = new Date(iso + 'T00:00:00');
      var hoje = new Date(); hoje.setHours(0, 0, 0, 0);
      return Math.ceil((alvo - hoje) / 86400000);
    }
  };
  PB.fmt = fmt;

  /* ---------------------------------------------------------------------
     MÍDIA DE FUNDO DO BANNER

     O campo `video` do banner tem três formas:

       ''                        banner de imagem, o fundo sai de `img`
       'assets/enviados/x.mp4'   arquivo enviado pelo administrador
       'youtube:<ID>'            vídeo hospedado no YouTube

     A montagem mora aqui porque a home e o painel do competidor precisam do
     mesmo resultado e são páginas independentes — duplicar o markup faria as
     duas divergirem no primeiro ajuste.
     --------------------------------------------------------------------- */

  function escAtr(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Aceita a forma gravada ('youtube:<ID>') e também um endereço colado
     inteiro: o campo passa pela validação de endereço do servidor, que deixa
     um https://youtu.be/... passar igual. Devolve '' quando não é YouTube.

     O identificador é devolvido só se for [A-Za-z0-9_-] — ele entra no src do
     iframe, e restringir o alfabeto aqui é o que impede um valor gravado no
     banco de virar outro endereço. */
  function idYoutube(valor) {
    var s = String(valor || '').trim();
    if (!s) return '';

    var bruto = '';
    var marcado = /^youtube:(.+)$/i.exec(s);
    if (marcado) {
      bruto = marcado[1];
    /* O domínio precisa terminar em youtu.be / youtube.com — o grupo de
       subdomínio só casa terminando em ponto, então um 'evil-youtube.com'
       não passa por aqui. */
    } else if (/^https?:\/\/([a-z0-9-]+\.)*youtu\.be\//i.test(s)) {
      bruto = s.split(/[?#]/)[0].split('/').pop();
    } else if (/^https?:\/\/([a-z0-9-]+\.)*youtube(-nocookie)?\.com\//i.test(s)) {
      /* /watch?v=ID, /embed/ID, /shorts/ID e /live/ID */
      var v = /[?&]v=([^&#]+)/.exec(s);
      bruto = v ? v[1] : (/\/(?:embed|shorts|live)\/([^/?#]+)/.exec(s) || [])[1] || '';
    } else {
      return '';
    }

    bruto = String(bruto || '').trim();
    return /^[A-Za-z0-9_-]{6,24}$/.test(bruto) ? bruto : '';
  }

  /* Parâmetros do player, na ordem em que importam:
     mute=1      nenhum navegador dá autoplay com som;
     loop=1      só repete acompanhado de playlist com o mesmo ID;
     controls=0, modestbranding=1, rel=0, iv_load_policy=3, showinfo=0, fs=0,
     disablekb=1 tiram botões, marca, anotações e sugestões — o pedido é um
                 fundo limpo, não um player;
     nocookie    a home não planta cookie de rastreio em quem só a abriu. */
  function embedYoutube(id) {
    return 'https://www.youtube-nocookie.com/embed/' + id + '?' + [
      'autoplay=1', 'mute=1', 'loop=1', 'playlist=' + id, 'controls=0',
      'modestbranding=1', 'rel=0', 'iv_load_policy=3', 'disablekb=1',
      'playsinline=1', 'fs=0', 'showinfo=0'
    ].join('&');
  }

  /* HTML do fundo de um slide.
       banner  registro de bannersSite (home) ou de banners (painel)
       base    caminho até a raiz do site: '' nas páginas públicas, '../'
               dentro de painel/ e admin/
       alt     texto alternativo da imagem; vazio marca a mídia como
               decorativa. Vídeo é sempre decorativo. */
  function midiaBanner(banner, base, alt) {
    var b = banner || {};
    var raiz = base || '';
    var caminho = function (p) {
      return /^assets\//.test(String(p)) ? raiz + p : String(p || '');
    };

    /* `midia` existe no banner do site; o do painel não tem o campo, então ter
       `video` preenchido já basta. Um banner que voltou para imagem guarda o
       vídeo antigo no registro — por isso 'imagem' vence. */
    if (b.video && b.midia !== 'imagem') {
      var id = idYoutube(b.video);
      if (id) {
        /* O iframe fica embrulhado porque é ele que vira o contêiner de
           dimensionamento do CSS (o vídeo é 16:9 e o banner não é). */
        return '<div class="banner-yt" aria-hidden="true">' +
          '<iframe class="banner-yt__quadro" src="' + escAtr(embedYoutube(id)) + '" ' +
          'title="Vídeo de fundo do banner" allow="autoplay; encrypted-media" ' +
          'frameborder="0" tabindex="-1" aria-hidden="true"></iframe></div>';
      }
      return '<video src="' + escAtr(caminho(b.video)) + '" ' +
        'autoplay muted loop playsinline aria-hidden="true"></video>';
    }

    return '<img src="' + escAtr(caminho(b.img)) + '" alt="' + escAtr(alt || '') + '"' +
      (alt ? '' : ' aria-hidden="true"') + '>';
  }

  PB.idYoutube = idYoutube;
  PB.embedYoutube = embedYoutube;
  PB.midiaBanner = midiaBanner;

  /* ---------------------------------------------------------------------
     CABEÇALHO — sombra ao rolar + menu mobile
     --------------------------------------------------------------------- */
  function iniciarCabecalho() {
    var cab = $('.cabecalho');
    if (cab) {
      var aoRolar = function () {
        cab.classList.toggle('cabecalho--fixo', global.scrollY > 12);
      };
      aoRolar();
      global.addEventListener('scroll', aoRolar, { passive: true });
    }

    var botao = $('[data-menu-toggle]');
    var painel = $('.nav-mobile');
    if (botao && painel) {
      botao.addEventListener('click', function () {
        var aberto = painel.classList.toggle('aberto');
        botao.setAttribute('aria-expanded', String(aberto));
        botao.setAttribute('aria-label', aberto ? 'Fechar menu' : 'Abrir menu');
        doc.body.style.overflow = aberto ? 'hidden' : '';
      });
      $$('a', painel).forEach(function (a) {
        a.addEventListener('click', function () {
          painel.classList.remove('aberto');
          botao.setAttribute('aria-expanded', 'false');
          doc.body.style.overflow = '';
        });
      });
    }
  }

  /* ---------------------------------------------------------------------
     HERO — slider acessível
     --------------------------------------------------------------------- */
  function iniciarHero() {
    var hero = $('[data-hero]');
    if (!hero) return;

    var slides = $$('.hero__slide', hero);
    var pontos = $$('.hero__ponto', hero);
    if (slides.length < 2) return;

    var atual = 0, timer = null;
    var INTERVALO = parseInt(hero.getAttribute('data-hero-intervalo') || '10000', 10);

    function ir(i) {
      atual = (i + slides.length) % slides.length;
      slides.forEach(function (s, k) {
        var entrando = k === atual;
        s.classList.toggle('ativo', entrando);
        /* Reinicia a animação de entrada do texto a cada troca */
        if (entrando) {
          var conteudo = $('.hero__conteudo, .banner-painel__conteudo', s);
          if (conteudo) {
            conteudo.classList.remove('entrando');
            void conteudo.offsetWidth;          /* força o reflow para a animação rodar de novo */
            conteudo.classList.add('entrando');
          }
        }
      });
      pontos.forEach(function (p, k) {
        p.classList.toggle('ativo', k === atual);
        p.setAttribute('aria-selected', String(k === atual));
      });
    }
    function proximo() { ir(atual + 1); }
    function tocar() { if (!reduzirMovimento) { parar(); timer = setInterval(proximo, INTERVALO); } }
    function parar() { if (timer) { clearInterval(timer); timer = null; } }

    pontos.forEach(function (p, k) {
      p.addEventListener('click', function () { ir(k); tocar(); });
    });

    hero.addEventListener('mouseenter', parar);
    hero.addEventListener('mouseleave', tocar);
    hero.addEventListener('focusin', parar);
    doc.addEventListener('visibilitychange', function () { doc.hidden ? parar() : tocar(); });

    ir(0);
    tocar();
  }

  /* ---------------------------------------------------------------------
     REVELAR AO ROLAR
     --------------------------------------------------------------------- */
  function iniciarRevelar() {
    var alvos = $$('.revelar');
    if (!alvos.length) return;
    if (reduzirMovimento || !('IntersectionObserver' in global)) {
      alvos.forEach(function (el) { el.classList.add('visivel'); });
      return;
    }
    var obs = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        var atraso = parseInt(el.getAttribute('data-atraso') || '0', 10);
        setTimeout(function () { el.classList.add('visivel'); }, atraso);
        obs.unobserve(el);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    alvos.forEach(function (el) { obs.observe(el); });

    /* Rede de segurança: conteúdo nunca pode ficar invisível porque o observer
       não disparou (aba em segundo plano, layout adiado, container com altura 0). */
    setTimeout(function () {
      $$('.revelar:not(.visivel)').forEach(function (el) {
        if (el.getBoundingClientRect().top < global.innerHeight * 1.5) el.classList.add('visivel');
      });
    }, 2500);
  }

  /* ---------------------------------------------------------------------
     CONTADOR ANIMADO
     --------------------------------------------------------------------- */
  function iniciarContadores() {
    var alvos = $$('[data-contar]');
    if (!alvos.length) return;

    function animar(el) {
      var destino = parseFloat(el.getAttribute('data-contar')) || 0;
      if (reduzirMovimento) { el.textContent = fmt.numero(destino); return; }

      var inicio = null, dur = 1100, terminou = false;
      function concluir() {
        if (terminou) return;
        terminou = true;
        el.textContent = fmt.numero(destino);
      }
      function passo(t) {
        if (terminou) return;
        if (!inicio) inicio = t;
        var p = Math.min((t - inicio) / dur, 1);
        if (p >= 1) { concluir(); return; }
        el.textContent = fmt.numero(Math.round(destino * (1 - Math.pow(1 - p, 3))));
        requestAnimationFrame(passo);
      }
      requestAnimationFrame(passo);

      /* requestAnimationFrame é pausado em aba de segundo plano: sem isto o
         número congela num valor parcial (ex.: "16" de 212) até a aba voltar. */
      setTimeout(concluir, dur + 400);
    }

    /* Valor final já vai para a tela: se o observer nunca disparar
       (aba em segundo plano, navegador antigo), o número continua correto. */
    alvos.forEach(function (el) {
      el.textContent = fmt.numero(parseFloat(el.getAttribute('data-contar')) || 0);
    });

    if (reduzirMovimento || !('IntersectionObserver' in global)) return;

    var obs = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { animar(e.target); obs.unobserve(e.target); } });
    }, { threshold: 0.35 });
    alvos.forEach(function (el) { obs.observe(el); });
  }

  /* ---------------------------------------------------------------------
     CONTAGEM REGRESSIVA
     --------------------------------------------------------------------- */
  function iniciarRegressiva() {
    var alvos = $$('[data-contagem]');
    if (!alvos.length) return;

    function atualizar() {
      alvos.forEach(function (el) {
        var alvo = new Date(el.getAttribute('data-contagem') + 'T00:00:00').getTime();
        var resta = Math.max(0, alvo - Date.now());
        var d = Math.floor(resta / 86400000);
        var h = Math.floor(resta / 3600000) % 24;
        var m = Math.floor(resta / 60000) % 60;
        var campos = { dias: d, horas: h, min: m };
        $$('[data-campo]', el).forEach(function (c) {
          var v = campos[c.getAttribute('data-campo')];
          if (v !== undefined) c.textContent = String(v).padStart(2, '0');
        });
      });
    }
    atualizar();
    setInterval(atualizar, 30000);
  }

  /* ---------------------------------------------------------------------
     ABAS
     --------------------------------------------------------------------- */
  function iniciarAbas() {
    $$('[data-abas]').forEach(function (grupo) {
      var abas = $$('[role="tab"]', grupo);
      if (!abas.length) return;

      function selecionar(aba) {
        abas.forEach(function (a) {
          var ativo = a === aba;
          a.setAttribute('aria-selected', String(ativo));
          a.tabIndex = ativo ? 0 : -1;
          var painel = doc.getElementById(a.getAttribute('aria-controls'));
          if (painel) painel.hidden = !ativo;
        });
      }

      abas.forEach(function (aba, i) {
        aba.addEventListener('click', function () { selecionar(aba); });
        aba.addEventListener('keydown', function (e) {
          var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          var prox = abas[(i + d + abas.length) % abas.length];
          prox.focus(); selecionar(prox);
        });
      });

      var inicial = abas.filter(function (a) { return a.getAttribute('aria-selected') === 'true'; })[0] || abas[0];
      selecionar(inicial);
    });
  }

  /* ---------------------------------------------------------------------
     FILTROS (galeria / listas)
     --------------------------------------------------------------------- */
  function iniciarFiltros() {
    $$('[data-filtros]').forEach(function (grupo) {
      var alvoSel = grupo.getAttribute('data-filtros');
      var botoes = $$('.filtro', grupo);
      botoes.forEach(function (b) {
        b.addEventListener('click', function () {
          var valor = b.getAttribute('data-valor');
          botoes.forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
          $$(alvoSel + ' [data-cat]').forEach(function (item) {
            var mostra = valor === 'todos' || item.getAttribute('data-cat') === valor;
            item.classList.toggle('esconder', !mostra);
          });
          var visiveis = $$(alvoSel + ' [data-cat]:not(.esconder)').length;
          var vazio = $(alvoSel + '-vazio');
          if (vazio) vazio.classList.toggle('esconder', visiveis > 0);
        });
      });
    });
  }

  /* ---------------------------------------------------------------------
     MODAL
     --------------------------------------------------------------------- */
  var modalAnterior = null;

  function abrirModal(id) {
    var m = doc.getElementById(id);
    if (!m) return;
    modalAnterior = doc.activeElement;
    m.classList.add('aberto');
    m.setAttribute('aria-hidden', 'false');
    doc.body.style.overflow = 'hidden';
    var foco = m.querySelector('button, [href], input, select, textarea');
    if (foco) foco.focus();
  }

  function fecharModal(m) {
    m = typeof m === 'string' ? doc.getElementById(m) : m;
    if (!m) return;
    m.classList.remove('aberto');
    m.setAttribute('aria-hidden', 'true');
    doc.body.style.overflow = '';
    if (modalAnterior && modalAnterior.focus) modalAnterior.focus();
  }

  function iniciarModais() {
    doc.addEventListener('click', function (e) {
      var abre = e.target.closest ? e.target.closest('[data-abrir-modal]') : null;
      if (abre) { e.preventDefault(); abrirModal(abre.getAttribute('data-abrir-modal')); return; }

      var fecha = e.target.closest ? e.target.closest('[data-fechar-modal]') : null;
      if (fecha) { e.preventDefault(); fecharModal(fecha.closest('.modal')); return; }

      if (e.target.classList && e.target.classList.contains('modal')) fecharModal(e.target);
    });

    doc.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var aberto = $('.modal.aberto');
      if (aberto) fecharModal(aberto);
    });
  }

  PB.abrirModal = abrirModal;
  PB.fecharModal = fecharModal;

  /* ---------------------------------------------------------------------
     TOASTS
     --------------------------------------------------------------------- */
  function toast(titulo, texto, tipo) {
    var caixa = $('.toasts');
    if (!caixa) {
      caixa = doc.createElement('div');
      caixa.className = 'toasts';
      caixa.setAttribute('role', 'status');
      caixa.setAttribute('aria-live', 'polite');
      doc.body.appendChild(caixa);
    }
    var t = doc.createElement('div');
    t.className = 'toast' + (tipo ? ' toast--' + tipo : '');
    var conteudo = doc.createElement('div');
    var s = doc.createElement('strong'); s.textContent = titulo;
    conteudo.appendChild(s);
    if (texto) { var p = doc.createElement('span'); p.textContent = texto; conteudo.appendChild(p); }
    t.appendChild(conteudo);
    caixa.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .3s, transform .3s';
      t.style.opacity = '0'; t.style.transform = 'translateX(20px)';
      setTimeout(function () { t.remove(); }, 320);
    }, 4200);
  }
  PB.toast = toast;

  /* ---------------------------------------------------------------------
     RECARREGAR APÓS SALVAR
     Toda gravação recarrega a tela para que a lista, os contadores e os
     campos apareçam já com o dado novo — sem estado meio atualizado.
     O atraso curto deixa o toast de confirmação visível antes do reload.
     --------------------------------------------------------------------- */
  PB.recarregar = function (atraso) {
    setTimeout(function () {
      /* preserva a querystring (?id=…) mas descarta âncora */
      global.location.replace(global.location.pathname + global.location.search);
    }, atraso === undefined ? 900 : atraso);
  };

  /* ---------------------------------------------------------------------
     ENVIO DE ARQUIVO

     Dez telas têm <input type="file"> e todas precisam da mesma coisa: subir
     o arquivo para POST /api/upload e guardar o caminho que volta. Cada tela
     resolvendo por conta própria foi o que deixou o protótipo com
     URL.createObjectURL — um blob que só existe naquela aba e morre no
     recarregamento — ou com o arquivo simplesmente descartado.

       var envio = PB.enviarArquivo(arquivo, opcoes, aoTerminar);
       envio.cancelar();

     opcoes: { aoProgresso: function (porcento) {}, classe: 'imagem'|'video' }

     `aoTerminar` recebe sempre um destes três, e nunca lança — quem chama está
     no meio de um formulário e não pode quebrar:

       { ok: true, caminho, tipo, classe, tamanho, largura, altura }
       { ok: false, erro: '<texto pronto para o usuário>', status }
       { cancelado: true }

     `caminho` é relativo à RAIZ do site ('assets/enviados/x.png'), porque é a
     home quem exibe. Página de painel ou de admin precisa do '../' na frente
     para mostrar o arquivo na tela; o que vai para o banco é o caminho puro.

     XMLHttpRequest e não fetch: só o XHR informa quanto do arquivo já subiu, e
     sem esse retorno o operador acha que travou, clica de novo e o mesmo vídeo
     de 40 MB sobe duas vezes.
     --------------------------------------------------------------------- */

  /* Os mesmos tetos de server/rotas/upload.js. Conferir aqui não substitui a
     conferência do servidor: evita gastar a subida inteira de um arquivo que
     vai levar 413 no fim. Só vale quando a tela informa `classe`.

     'imagem-blog' é o teto especial da redação do blog: foto principal e
     galeria sobem no tamanho original. O servidor só aceita o hint quando a
     conta tem 'blog:escrever'; em todas as outras telas 'imagem' padrão
     continua sendo 5 MB. */
  var TETOS_ENVIO = {
    imagem: 5 * 1024 * 1024,
    'imagem-blog': 100 * 1024 * 1024,
    documento: 100 * 1024 * 1024,
    video: 50 * 1024 * 1024
  };

  /* Sem back-end o arquivo tem de caber no localStorage junto com o resto dos
     dados, e o teto do navegador é de poucos megabytes. */
  var TETO_SEM_SERVIDOR = 1.5 * 1024 * 1024;

  function tamanhoLegivel(bytes) {
    return bytes >= 1024 * 1024
      ? (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB'
      : Math.round(bytes / 1024) + ' KB';
  }

  function urlDoEnvio(classe) {
    var base = ((global.PB && PB.api && PB.api.BASE) || '/api') + '/upload';
    /* Hoje só uma dica sobe pelo query: 'imagem-blog', que o servidor honra
       apenas para quem tem 'blog:escrever'. Outros valores são ignorados no
       cliente para não vazarem para a URL. */
    if (classe === 'imagem-blog') return base + '?classe=imagem-blog';
    return base;
  }

  /* O texto que o usuário lê. O status importa porque a saída é diferente em
     cada caso: 401 se resolve entrando de novo, 403 não se resolve sozinho. */
  function erroDoEnvio(status, resposta) {
    var doServidor = resposta && resposta.erro ? String(resposta.erro) : '';

    if (!status) return 'A conexão caiu durante o envio. Tente de novo.';
    if (status === 401) return 'Sua sessão expirou. Entre de novo e repita o envio.';
    if (status === 403) return 'Esta conta não tem permissão para enviar arquivos. Fale com um administrador master.';
    if (status === 413) return doServidor || 'O arquivo passa do limite aceito pelo servidor.';
    if (status === 400) return doServidor || 'O servidor não reconheceu este arquivo.';
    return doServidor || 'O servidor recusou o arquivo (HTTP ' + status + ').';
  }

  /* Resposta imediata, antes de qualquer rede. Devolve o mesmo formato das
     outras saídas para a tela ter um caminho só de tratamento. */
  function envioRecusado(pronto, erro) {
    pronto({ ok: false, status: 0, erro: erro });
    return { cancelar: function () {} };
  }

  /* Demonstração estática (GitHub Pages, file://): não há para onde subir,
     então o arquivo vira data: URL. Não é bonito, mas sobrevive ao
     recarregamento — que é justamente o que o blob: de antes não fazia. */
  function lerSemServidor(arquivo, op, avisar, pronto) {
    if (arquivo.size > TETO_SEM_SERVIDOR) {
      return envioRecusado(pronto,
        'Sem servidor esta demonstração só guarda arquivos de até ' + tamanhoLegivel(TETO_SEM_SERVIDOR) +
        ' (este tem ' + tamanhoLegivel(arquivo.size) + '). Ligue o back-end para enviar arquivos maiores.');
    }

    var leitor = new global.FileReader();
    var respondeu = false;

    function entregar(resultado) {
      if (respondeu) return;
      respondeu = true;
      pronto(resultado);
    }

    leitor.onprogress = function (e) {
      if (e.lengthComputable) avisar(Math.round((e.loaded / e.total) * 100));
    };
    leitor.onload = function () {
      entregar({
        ok: true,
        caminho: String(leitor.result),
        tipo: arquivo.type || '',
        classe: op.classe || (/^video\//.test(arquivo.type) ? 'video' : 'imagem'),
        tamanho: arquivo.size
      });
    };
    leitor.onerror = function () { entregar({ ok: false, status: 0, erro: 'Não foi possível ler o arquivo escolhido.' }); };
    leitor.onabort = function () { entregar({ cancelado: true }); };

    avisar(0);
    leitor.readAsDataURL(arquivo);

    return { cancelar: function () { if (!respondeu) leitor.abort(); } };
  }

  function enviarArquivo(arquivo, opcoes, aoTerminar) {
    var op = opcoes || {};
    var avisar = typeof op.aoProgresso === 'function' ? op.aoProgresso : function () {};
    var pronto = typeof aoTerminar === 'function' ? aoTerminar : function () {};

    if (!arquivo) return envioRecusado(pronto, 'Nenhum arquivo foi escolhido.');

    var teto = TETOS_ENVIO[op.classe];
    if (teto && arquivo.size > teto) {
      var comeco = op.classe === 'video' ? 'O vídeo tem '
        : op.classe === 'documento' ? 'O documento tem '
        : 'A imagem tem ';                       /* imagem e imagem-blog */
      return envioRecusado(pronto,
        comeco + tamanhoLegivel(arquivo.size) +
        ' e o limite é ' + tamanhoLegivel(teto) + '.');
    }

    if (!PB.dados || typeof PB.dados.modo !== 'function' || PB.dados.modo() !== 'api') {
      return lerSemServidor(arquivo, op, avisar, pronto);
    }

    var req = new global.XMLHttpRequest();
    var pacote = new global.FormData();
    var respondeu = false;

    /* abort dispara 'abort' e 'loadend'; erro de rede pode disparar mais de um
       evento. A tela não pode receber duas respostas para um envio só. */
    function entregar(resultado) {
      if (respondeu) return;
      respondeu = true;
      pronto(resultado);
    }

    pacote.append('arquivo', arquivo, arquivo.name);

    req.open('POST', urlDoEnvio(op.classe), true);
    req.setRequestHeader('Accept', 'application/json');

    req.upload.addEventListener('progress', function (e) {
      if (!e.lengthComputable) return;
      avisar(Math.round((e.loaded / e.total) * 100));
    });

    req.addEventListener('load', function () {
      var resposta = null;
      try { resposta = JSON.parse(req.responseText); } catch (e) { resposta = null; }

      if (req.status >= 200 && req.status < 300 && resposta && resposta.caminho) {
        entregar({
          ok: true,
          caminho: resposta.caminho,
          tipo: resposta.tipo,
          classe: resposta.classe,
          tamanho: resposta.tamanho,
          largura: resposta.largura,
          altura: resposta.altura
        });
        return;
      }
      entregar({ ok: false, status: req.status, erro: erroDoEnvio(req.status, resposta) });
    });

    req.addEventListener('error', function () {
      entregar({ ok: false, status: 0, erro: erroDoEnvio(0, null) });
    });
    /* Cancelamento é decisão de quem está na tela, não falha: quem chama já
       limpou o formulário e não tem nada a avisar. */
    req.addEventListener('abort', function () { entregar({ cancelado: true }); });

    avisar(0);
    req.send(pacote);

    return { cancelar: function () { if (!respondeu) req.abort(); } };
  }

  /* Vários arquivos, um DE CADA VEZ. Dez envios simultâneos de 5 MB disputam a
     mesma banda de subida: nenhum termina antes do último, e a barra fica
     parada o caminho inteiro.

     `aoTerminar` recebe a lista de resultados na ordem dos arquivos, sempre com
     o mesmo tamanho da entrada. `aoProgresso` recebe o andamento do conjunto
     (0 a 100) e ainda o índice do arquivo em curso e o total, para a tela poder
     escrever "foto 3 de 10". */
  function enviarVarios(arquivos, opcoes, aoTerminar) {
    var lista = Array.prototype.slice.call(arquivos || []);
    var op = opcoes || {};
    var avisar = typeof op.aoProgresso === 'function' ? op.aoProgresso : function () {};
    var pronto = typeof aoTerminar === 'function' ? aoTerminar : function () {};

    var resultados = [];
    var emCurso = null;
    var parado = false;

    function preencherResto(resultado) {
      while (resultados.length < lista.length) resultados.push(resultado);
    }

    function seguir() {
      if (parado || resultados.length >= lista.length) { pronto(resultados); return; }

      var i = resultados.length;
      var respondeu = false;

      var envio = enviarArquivo(lista[i], {
        classe: op.classe,
        aoProgresso: function (pct) {
          avisar(Math.round((i * 100 + pct) / lista.length), i, lista.length);
        }
      }, function (r) {
        respondeu = true;
        emCurso = null;
        resultados.push(r);

        /* 401 e 403 são da conta, não do arquivo: insistir nos outros nove
           repetiria o mesmo erro nove vezes. O resto da fila é preenchido para
           a lista continuar casando com a ordem dos arquivos. */
        if (r.cancelado) {
          parado = true;
          preencherResto({ cancelado: true });
        } else if (!r.ok && (r.status === 401 || r.status === 403)) {
          parado = true;
          preencherResto({ ok: false, status: r.status, erro: r.erro });
        }

        seguir();
      });

      /* Envio recusado na hora (arquivo grande demais) já respondeu e a fila
         andou: guardar o handle agora apagaria o do arquivo seguinte. */
      if (!respondeu) emCurso = envio;
    }

    seguir();

    return {
      cancelar: function () {
        parado = true;
        if (emCurso) emCurso.cancelar();
      }
    };
  }

  PB.enviarArquivo = enviarArquivo;
  PB.enviarVarios = enviarVarios;

  /* ---------------------------------------------------------------------
     PAINEL — menu lateral e submenus
     --------------------------------------------------------------------- */
  function iniciarPainel() {
    var lateral = $('.painel__lateral');
    var toggle = $('[data-painel-toggle]');
    if (lateral && toggle) {
      var overlay = $('.painel__overlay');
      if (!overlay) {
        overlay = doc.createElement('div');
        overlay.className = 'painel__overlay';
        doc.body.appendChild(overlay);
      }
      var alternar = function (forcar) {
        var aberto = forcar !== undefined ? forcar : !lateral.classList.contains('aberto');
        lateral.classList.toggle('aberto', aberto);
        overlay.classList.toggle('ativo', aberto);
        toggle.setAttribute('aria-expanded', String(aberto));
      };
      toggle.addEventListener('click', function () { alternar(); });
      overlay.addEventListener('click', function () { alternar(false); });
    }

    $$('[data-submenu]').forEach(function (botao) {
      var item = botao.closest('.menu__item');
      var sub = item && $('.menu__sub', item);
      if (!sub) return;
      var aberto = item.getAttribute('aria-expanded') === 'true';
      sub.hidden = !aberto;
      botao.addEventListener('click', function () {
        var novo = item.getAttribute('aria-expanded') !== 'true';
        item.setAttribute('aria-expanded', String(novo));
        botao.setAttribute('aria-expanded', String(novo));
        sub.hidden = !novo;
      });
    });
  }

  /* ---------------------------------------------------------------------
     IDENTIDADE NO RODAPÉ DO MENU

     O bloco .painel__usuario trazia "DM / Diego Martins / Responsável de time"
     escrito no HTML de dez telas do competidor, e "IP / Inscrições Phygital /
     Master" em todas as do admin. Quem entrasse com outra conta continuava
     lendo o nome do vizinho — e, no admin, um nível de acesso que não é o seu.

     O preenchimento mora aqui, e não no script de cada página, porque o bloco
     é idêntico nos dois painéis: repetir o trecho em trinta arquivos garantia
     que eles divergiriam no primeiro ajuste. As páginas continuam com o texto
     fixo no HTML, que serve de conteúdo inicial até este passo rodar.
     --------------------------------------------------------------------- */
  var NIVEIS_POR_EXTENSO = {
    master: 'Master',
    gestor: 'Gestor de Campeonato',
    operacao: 'Operação'
  };

  function iniciarIdentidade() {
    var blocos = $$('.painel__usuario');
    if (!blocos.length || !global.PB || !PB.dados) return;

    var conta = (PB.dados.sessao && PB.dados.sessao()) || null;

    /* Modo local (GitHub Pages): não existe sessão de servidor, e quem abre o
       painel direto, sem passar pelo login de demonstração, não tem nada no
       localStorage. Aí vale o usuário da semente — é o dono dos times e das
       inscrições que a tela está mostrando, então é o nome certo. Isso só faz
       sentido na área do competidor: a semente não tem administrador, e
       carimbar "Responsável de time" no menu do admin seria pior que o texto
       fixo que já está no HTML. */
    var local = typeof PB.dados.modo !== 'function' || PB.dados.modo() !== 'api';
    if (!conta && local && !/\/admin\//.test(global.location.pathname)) {
      var semente = PB.dados.usuario && PB.dados.usuario();
      if (semente && semente.nome) conta = { nome: semente.nome, papel: 'competidor' };
    }

    if (!conta || !conta.nome) return;   /* sem nome não há o que escrever */

    var papel = conta.papel === 'admin'
      ? (NIVEIS_POR_EXTENSO[conta.nivel] || 'Administração')
      : 'Responsável de time';

    blocos.forEach(function (bloco) {
      var avatar = $('.avatar', bloco);
      var nome = $('.nome', bloco);
      var cargo = $('.papel', bloco);
      if (avatar) avatar.textContent = fmt.iniciais(conta.nome);
      if (nome) nome.textContent = conta.nome;
      if (cargo) cargo.textContent = papel;
    });
  }

  /* ---------------------------------------------------------------------
     CONTADORES DO MENU
     O badge de chamados era um número fixo no HTML e continuava mostrando 3
     mesmo com tudo encerrado. Agora é calculado a partir dos dados — dos
     dois lados: o painel local (arrays sínc.) e o Codespaces/API (Promise).
     O badge nasce `hidden` no HTML; se o backend responder com abertos, cai
     o hidden e o número aparece; se falhar ou vier zero, continua invisível.
     --------------------------------------------------------------------- */
  function iniciarContadoresMenu() {
    if (!global.PB || !PB.dados) return;

    var badges = $$('[data-conta-chamados]');
    if (!badges.length) return;

    function pintar(n) {
      var abertos = Number(n) || 0;
      badges.forEach(function (b) {
        if (abertos > 0) {
          b.textContent = String(abertos);
          b.hidden = false;
          b.setAttribute('aria-label', abertos + ' chamado(s) em aberto');
        } else {
          /* zero chamados abertos: o badge some em vez de mostrar "0" */
          b.hidden = true;
        }
      });
    }

    var ehAdmin = /\/admin\//.test(global.location.pathname);

    /* Cada modo expõe uma função diferente:
         · modo local admin      → PB.dados.adminChamados('abertos') = array
         · modo local competidor → PB.dados.chamados()              = array
         · modo API   admin      → PB.dados.metricas()              = Promise<{chamadosAbertos}>
         · modo API   competidor → PB.dados.chamados()              = Promise<array>
       Promise.resolve() aceita array E Promise, então trata os dois iguais. */
    var fonte;
    try {
      if (ehAdmin && typeof PB.dados.adminChamados === 'function') {
        fonte = PB.dados.adminChamados('abertos');
      } else if (ehAdmin && typeof PB.dados.metricas === 'function') {
        fonte = PB.dados.metricas();
      } else if (typeof PB.dados.chamados === 'function') {
        fonte = PB.dados.chamados();
      } else {
        return;
      }
    } catch (_) { return; }

    Promise.resolve(fonte).then(function (r) {
      if (Array.isArray(r)) {
        /* adminChamados('abertos') já veio filtrada; chamados() traz tudo. */
        var abertos = ehAdmin
          ? r.length
          : r.filter(function (c) { return c && c.status !== 'encerrado'; }).length;
        pintar(abertos);
      } else if (r && typeof r === 'object') {
        pintar(r.chamadosAbertos);
      }
    }).catch(function () { /* sem backend: o badge continua com hidden do HTML */ });
  }

  /* ---------------------------------------------------------------------
     SUBMENU: marca o item realmente aberto
     Comparar só o arquivo marcava "Copa Futebol" enquanto se navegava no
     "Shooter Open", porque os dois apontam para campeonato-gerenciar.html.
     A querystring precisa entrar na comparação.
     --------------------------------------------------------------------- */
  function iniciarSubmenuAtivo() {
    var subs = $$('.menu__sub');
    if (!subs.length) return;

    var arquivoAtual = global.location.pathname.split('/').pop() || 'index.html';
    var idAtual = new URLSearchParams(global.location.search).get('id');

    subs.forEach(function (ul) {
      var links = $$('a', ul);
      var achou = false;

      links.forEach(function (a) {
        var href = a.getAttribute('href') || '';
        var arquivo = href.split('?')[0].split('/').pop();
        var id = (href.split('?')[1] || '').match(/(?:^|&)id=([^&]*)/);
        id = id ? decodeURIComponent(id[1]) : null;

        var ativo = arquivo === arquivoAtual && (id === null ? idAtual === null : id === idAtual);
        a.classList.toggle('ativo', ativo);
        if (ativo) { a.setAttribute('aria-current', 'page'); achou = true; }
        else a.removeAttribute('aria-current');
      });

      /* Estamos numa tela do grupo mas em nenhum item listado (ex.: ficha de
         time ou apuração): abre o submenu sem marcar item errado. */
      var item = ul.closest('.menu__item');
      if (item && item.classList.contains('menu__item--ativo') && !achou) {
        ul.hidden = false;
        item.setAttribute('aria-expanded', 'true');
      }
    });
  }

  /* ---------------------------------------------------------------------
     SUBMENU DINÂMICO — CAMPEONATOS
     O submenu "Campeonatos" do painel admin costumava listar três nomes
     fixos no HTML — os campeonatos-semente do modo local. Publicar um
     campeonato novo não aparecia ali; encerrar um seguia mostrando.
     Agora o HTML entrega só o item "+ Criar Novo Campeonato" (marcado
     com data-submenu-fim) e esta função insere ANTES dele os campeonatos
     realmente abertos — status 'inscricoes' ou 'em-andamento', ignorando
     arquivados. Sem backend ou sem admin, a função não faz nada e o item
     estático "+ Criar Novo" continua servindo de fallback.
     --------------------------------------------------------------------- */
  function iniciarSubmenuCampeonatos() {
    var ancoras = $$('[data-submenu-campeonatos]');
    if (!ancoras.length) return;
    if (!global.PB || !PB.dados || typeof PB.dados.campeonatos !== 'function') return;

    /* Nome curto para caber no menu lateral sem quebrar em duas linhas.
       Corta na primeira ocorrência de " —" (travessão do subtítulo) ou,
       na ausência dele, nos primeiros 30 caracteres. */
    function encurtar(nome) {
      var s = String(nome == null ? '' : nome).trim();
      if (!s) return '';
      var corte = s.indexOf(' —');
      if (corte > 0) return s.slice(0, corte);
      if (s.length > 30) {
        var cru = s.slice(0, 30).replace(/\s+\S*$/, '');
        return (cru || s.slice(0, 30)) + '…';
      }
      return s;
    }

    function aberto(c) {
      if (!c) return false;
      if (c.arquivado || c.arquivado_em || c.arquivadoEm) return false;
      return c.status === 'inscricoes' || c.status === 'em-andamento';
    }

    var fonte;
    try { fonte = PB.dados.campeonatos(); } catch (_) { return; }

    Promise.resolve(fonte).then(function (r) {
      var lista;
      if (Array.isArray(r)) lista = r;
      else if (r && Array.isArray(r.campeonatos)) lista = r.campeonatos;
      else return;

      var abertos = lista.filter(aberto);
      if (!abertos.length) return;

      ancoras.forEach(function (ul) {
        var fim = $('[data-submenu-fim]', ul);
        abertos.forEach(function (c) {
          if (!c || !c.id) return;
          var li = doc.createElement('li');
          var a = doc.createElement('a');
          a.setAttribute('href', 'campeonato-gerenciar.html?id=' + encodeURIComponent(c.id));
          a.textContent = encurtar(c.nome);
          li.appendChild(a);
          if (fim) ul.insertBefore(li, fim); else ul.appendChild(li);
        });
      });

      /* Os itens acabaram de nascer: repassar o marcador de "ativo" para
         que o item da URL corrente ganhe .ativo e aria-current. */
      iniciarSubmenuAtivo();
    }).catch(function () { /* sem backend: fica só o "+ Criar Novo" estático */ });
  }

  /* ---------------------------------------------------------------------
     SAIR DA CONTA
     --------------------------------------------------------------------- */
  function iniciarSair() {
    $$('[data-sair]').forEach(function (bt) {
      bt.addEventListener('click', function (e) {
        e.preventDefault();
        var destino = bt.getAttribute('data-sair') || 'login.html';
        PB.confirmar(
          'Sair da conta',
          'Você será desconectado e voltará para a tela de login. Deseja realmente sair?',
          function () {
            if (global.PB && PB.dados && PB.dados.encerrarSessao) PB.dados.encerrarSessao();
            toast('Sessão encerrada', 'Até logo.', 'info');
            setTimeout(function () { global.location.href = destino; }, 600);
          });
      });
    });
  }

  /* ---------------------------------------------------------------------
     SPLASH DO PAINEL DO COMPETIDOR
     --------------------------------------------------------------------- */
  function iniciarSplash() {
    var splash = $('[data-splash]');
    if (!splash) return;
    var destino = splash.getAttribute('data-splash');
    var espera = parseInt(splash.getAttribute('data-espera') || '1800', 10);
    setTimeout(function () {
      splash.classList.add('saindo');
      setTimeout(function () { if (destino) global.location.href = destino; }, 420);
    }, espera);
  }

  /* ---------------------------------------------------------------------
     FORMULÁRIOS — máscaras, validação e OTP
     --------------------------------------------------------------------- */
  function iniciarFormularios() {
    $$('[data-mascara="telefone"]').forEach(function (el) {
      el.addEventListener('input', function () { el.value = fmt.telefone(el.value); });
    });

    /* Validação: mensagem junto ao campo, nunca só um alerta no topo */
    $$('form[data-validar]').forEach(function (form) {
      form.setAttribute('novalidate', 'novalidate');
    });

    /* CAPTURA NO DOCUMENTO, não listener no formulário.

       O script inline de cada página roda no parse e registra o próprio submit
       ANTES deste arquivo chegar ao DOMContentLoaded. Listener no formulário
       entraria depois na fila, então preventDefault() barrava só o envio nativo
       e a página gravava assim mesmo — em admin/blog-post.html dava para
       publicar sem a foto principal, com o campo marcado em vermelho na tela.

       Na fase de captura o documento é visitado antes do formulário, o que
       coloca a validação na frente de qualquer listener da página, e
       stopImmediatePropagation impede que eles cheguem a rodar. */
    doc.addEventListener('submit', function (e) {
      var form = e.target;
      if (!form || !form.hasAttribute || !form.hasAttribute('data-validar')) return;
        var primeiroErro = null;
        $$('[required]', form).forEach(function (campo) {
          var wrap = campo.closest('.campo') || campo.parentElement;
          var erroEl = wrap && $('.campo__erro', wrap);
          var ok = campo.checkValidity() && String(campo.value).trim() !== '';

          if (campo.type === 'checkbox') ok = campo.checked;

          if (wrap) wrap.classList.toggle('campo--erro', !ok);
          if (erroEl) erroEl.hidden = ok;
          if (!ok && !primeiroErro) primeiroErro = campo;
        });

        /* Confirmação de senha */
        var senha = $('[data-senha]', form);
        var confirma = $('[data-senha-confirma]', form);
        if (senha && confirma) {
          var igual = senha.value === confirma.value && confirma.value !== '';
          var w = confirma.closest('.campo');
          if (w) w.classList.toggle('campo--erro', !igual);
          var er = w && $('.campo__erro', w);
          if (er) { er.hidden = igual; if (!igual) er.textContent = 'As senhas não conferem.'; }
          if (!igual && !primeiroErro) primeiroErro = confirma;
        }

        if (primeiroErro) {
          e.preventDefault();
          e.stopImmediatePropagation();
          primeiroErro.focus();
          primeiroErro.scrollIntoView({ block: 'center', behavior: reduzirMovimento ? 'auto' : 'smooth' });
          return;
        }

        if (form.hasAttribute('data-demo')) {
          e.preventDefault();
          var msg = form.getAttribute('data-demo') || 'Ação registrada.';
          toast('Protótipo', msg, 'info');
          var destino = form.getAttribute('data-ir-para');
          if (destino) setTimeout(function () { global.location.href = destino; }, 900);
        }
    }, true);

    /* Campos de código (OTP): avança e volta sozinho */
    $$('.otp').forEach(function (grupo) {
      var campos = $$('input', grupo);
      campos.forEach(function (campo, i) {
        campo.setAttribute('inputmode', 'numeric');
        campo.setAttribute('maxlength', '1');
        campo.setAttribute('autocomplete', i === 0 ? 'one-time-code' : 'off');
        campo.addEventListener('input', function () {
          campo.value = campo.value.replace(/\D/g, '');
          if (campo.value && campos[i + 1]) campos[i + 1].focus();
        });
        campo.addEventListener('keydown', function (e) {
          if (e.key === 'Backspace' && !campo.value && campos[i - 1]) campos[i - 1].focus();
        });
        /* Colar o código inteiro preenche todos os campos */
        campo.addEventListener('paste', function (e) {
          var txt = (e.clipboardData || global.clipboardData).getData('text').replace(/\D/g, '');
          if (!txt) return;
          e.preventDefault();
          campos.forEach(function (c, k) { c.value = txt[k] || ''; });
          (campos[Math.min(txt.length, campos.length - 1)]).focus();
        });
      });
    });

    /* Upload com pré-visualização */
    $$('[data-upload]').forEach(function (area) {
      var input = $('input[type="file"]', area);
      if (!input) return;
      area.addEventListener('click', function (e) { if (e.target !== input) input.click(); });
      area.addEventListener('dragover', function (e) { e.preventDefault(); area.classList.add('upload--ativo'); });
      area.addEventListener('dragleave', function () { area.classList.remove('upload--ativo'); });
      area.addEventListener('drop', function (e) {
        e.preventDefault();
        area.classList.remove('upload--ativo');
        if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; mostrarArquivo(); }
      });
      input.addEventListener('change', mostrarArquivo);

      function mostrarArquivo() {
        var arq = input.files && input.files[0];
        if (!arq) return;
        var nome = $('[data-upload-nome]', area);
        if (nome) nome.textContent = arq.name + ' · ' + Math.round(arq.size / 1024) + ' KB';
        var prev = $('[data-upload-preview]', area);
        if (prev && /^image\//.test(arq.type)) {
          var url = URL.createObjectURL(arq);
          prev.src = url; prev.hidden = false;
          prev.addEventListener('load', function () { URL.revokeObjectURL(url); }, { once: true });
        }
      }
    });

    /* Mostrar/ocultar senha */
    $$('[data-ver-senha]').forEach(function (b) {
      b.addEventListener('click', function () {
        var alvo = doc.getElementById(b.getAttribute('data-ver-senha'));
        if (!alvo) return;
        var vendo = alvo.type === 'text';
        alvo.type = vendo ? 'password' : 'text';
        b.setAttribute('aria-label', vendo ? 'Mostrar senha' : 'Ocultar senha');
        b.setAttribute('aria-pressed', String(!vendo));
      });
    });
  }

  /* ---------------------------------------------------------------------
     CONFIRMAÇÃO EM AÇÕES IRREVERSÍVEIS
     --------------------------------------------------------------------- */
  function iniciarConfirmacoes() {
    doc.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-confirmar]') : null;
      if (!el) return;
      e.preventDefault();
      var texto = el.getAttribute('data-confirmar');
      var titulo = el.getAttribute('data-confirmar-titulo') || 'Confirmar ação';
      PB.confirmar(titulo, texto, function () {
        var msg = el.getAttribute('data-confirmar-ok') || 'Ação concluída.';
        toast('Pronto', msg, 'info');
        var destino = el.getAttribute('data-ir-para');
        if (destino) setTimeout(function () { global.location.href = destino; }, 800);
      });
    });
  }

  /* Modal de confirmação criado sob demanda */
  PB.confirmar = function (titulo, texto, aoConfirmar) {
    var m = doc.getElementById('modal-confirmar');
    if (!m) {
      m = doc.createElement('div');
      m.className = 'modal';
      m.id = 'modal-confirmar';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      m.innerHTML =
        '<div class="modal__caixa" role="document">' +
          '<span class="fita"></span>' +
          '<div class="modal__corpo">' +
            '<h2 id="modal-confirmar-titulo" style="font-size:1.375rem"></h2>' +
            '<p id="modal-confirmar-texto" class="txt-suave"></p>' +
            '<div class="modal__acoes">' +
              '<button type="button" class="btn btn--fantasma" data-fechar-modal>Cancelar ação</button>' +
              '<button type="button" class="btn btn--primario" data-confirmar-sim>Sim, confirmar</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      doc.body.appendChild(m);
      m.setAttribute('aria-labelledby', 'modal-confirmar-titulo');
    }
    $('#modal-confirmar-titulo', m).textContent = titulo;
    $('#modal-confirmar-texto', m).textContent = texto;

    var sim = $('[data-confirmar-sim]', m);
    var novo = sim.cloneNode(true);
    sim.parentNode.replaceChild(novo, sim);
    novo.addEventListener('click', function () {
      fecharModal(m);
      if (typeof aoConfirmar === 'function') aoConfirmar();
    });
    abrirModal('modal-confirmar');
  };

  /* ---------------------------------------------------------------------
     MODALIDADE "OUTROS" NO MENU
     As quatro modalidades principais são fixas. "Outros" só entra no menu
     quando existe algum campeonato cadastrado fora dessas quatro.
     --------------------------------------------------------------------- */
  var MODALIDADES_FIXAS = ['futebol', 'basquete', 'shooter', 'dance'];

  function existeOutraModalidade() {
    if (!global.PB || !PB.dados || !PB.dados.campeonatos) return false;
    return PB.dados.campeonatos().some(function (c) {
      return MODALIDADES_FIXAS.indexOf(c.modalidade) === -1;
    });
  }
  PB.existeOutraModalidade = existeOutraModalidade;

  function iniciarModalidadeExtra() {
    var listas = $$('[data-lista-modalidades]');
    if (!listas.length || !existeOutraModalidade()) return;

    var naPagina = /mod-outros\.html/.test(global.location.pathname);
    listas.forEach(function (ul) {
      if ($('a[href="mod-outros.html"]', ul)) return;
      var li = doc.createElement('li');
      var tipo = ul.getAttribute('data-lista-modalidades');
      var rotulo = tipo === 'rodape' ? 'Outras modalidades' : 'Outros';
      var atual = naPagina ? ' aria-current="page"' : '';
      li.innerHTML = tipo === 'submenu'
        ? '<a href="mod-outros.html"' + atual + '><span class="ponto" style="background:#6E7377"></span> ' + rotulo + '</a>'
        : '<a href="mod-outros.html"' + atual + '>' + rotulo + '</a>';
      ul.appendChild(li);
    });
  }

  /* ---------------------------------------------------------------------
     ANO CORRENTE NO RODAPÉ
     --------------------------------------------------------------------- */
  function iniciarAno() {
    $$('[data-ano]').forEach(function (el) { el.textContent = new Date().getFullYear(); });
  }

  /* ---------------------------------------------------------------------
     BOOT
     --------------------------------------------------------------------- */
  function iniciar() {
    iniciarCabecalho();
    iniciarHero();
    iniciarRevelar();
    iniciarContadores();
    iniciarRegressiva();
    iniciarAbas();
    iniciarFiltros();
    iniciarModais();
    iniciarPainel();
    iniciarIdentidade();
    iniciarSplash();
    iniciarFormularios();
    iniciarConfirmacoes();
    iniciarModalidadeExtra();
    iniciarContadoresMenu();
    iniciarSubmenuAtivo();
    iniciarSubmenuCampeonatos();
    iniciarSair();
    iniciarAno();
    if (typeof PB.aoIniciar === 'function') PB.aoIniciar();
  }

  /* Página protegida sem sessão já está saindo: montar a tela seria trabalho
     jogado fora, e sobre dados que não existem. */
  if (saindo) {
    /* nada a inicializar */
  } else if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }

  PB.$ = $;
  PB.$$ = $$;
})(window, document);
