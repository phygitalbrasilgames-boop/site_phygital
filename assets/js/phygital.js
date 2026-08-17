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
     CONTADORES DO MENU
     O badge de chamados era um número fixo no HTML e continuava mostrando 3
     mesmo com tudo encerrado. Agora é calculado a partir dos dados.
     --------------------------------------------------------------------- */
  function iniciarContadoresMenu() {
    if (!global.PB || !PB.dados) return;

    var badges = $$('[data-conta-chamados]');
    if (!badges.length) return;

    var ehAdmin = /\/admin\//.test(global.location.pathname);
    var abertos = ehAdmin
      ? (PB.dados.adminChamados('abertos') || []).length
      : (PB.dados.chamados() || []).filter(function (c) { return c.status !== 'encerrado'; }).length;

    badges.forEach(function (b) {
      if (abertos > 0) {
        b.textContent = abertos;
        b.hidden = false;
        b.setAttribute('aria-label', abertos + ' chamado(s) em aberto');
      } else {
        /* zero chamados abertos: o badge some em vez de mostrar "0" */
        b.hidden = true;
      }
    });
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
      form.addEventListener('submit', function (e) {
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
      });
    });

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
    iniciarSplash();
    iniciarFormularios();
    iniciarConfirmacoes();
    iniciarModalidadeExtra();
    iniciarContadoresMenu();
    iniciarSubmenuAtivo();
    iniciarSair();
    iniciarAno();
    if (typeof PB.aoIniciar === 'function') PB.aoIniciar();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }

  PB.$ = $;
  PB.$$ = $$;
})(window, document);
